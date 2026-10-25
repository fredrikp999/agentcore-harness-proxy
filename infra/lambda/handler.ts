import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Provided by the Lambda Node.js runtime for response streaming.
declare const awslambda: {
  streamifyResponse(
    handler: (event: FunctionUrlEvent, stream: Writable, context: unknown) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: Writable, meta: { statusCode: number; headers?: Record<string, string> }): Writable;
  };
};

interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

const TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN ?? "";
const AUD = process.env.ACCESS_AUD ?? "";
const HARNESSES: Record<string, string> = JSON.parse(process.env.HARNESS_ARNS ?? "{}");
const DEFAULT_HARNESS = Object.keys(HARNESSES)[0];

const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOKENS_CAP = 8_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{33,}$/;

const jwks = createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`));
const clients = new Map<string, BedrockAgentCoreClient>();

function clientFor(harnessArn: string): BedrockAgentCoreClient {
  const region = harnessArn.split(":")[3];
  let client = clients.get(region);
  if (!client) {
    client = new BedrockAgentCoreClient({ region });
    clients.set(region, client);
  }
  return client;
}

async function authenticate(event: FunctionUrlEvent): Promise<string | undefined> {
  const token = event.headers?.["cf-access-jwt-assertion"];
  if (!TEAM_DOMAIN || !AUD) {
    console.error("ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set");
    return undefined;
  }
  if (!token) {
    console.warn("access jwt missing");
    return undefined;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${TEAM_DOMAIN}`,
      audience: AUD,
    });
    // A service token's JWT has sub: "" (an empty string, which ?? would keep), so skip blanks
    // and always return a non-empty identity: the caller treats a falsy one as unauthenticated.
    const id = [payload.email, payload.common_name, payload.sub].find(
      (v): v is string => typeof v === "string" && v !== "",
    );
    return id ?? "service-token";
  } catch (err) {
    console.warn("access jwt rejected", (err as Error).message);
    return undefined;
  }
}

function respond(stream: Writable, statusCode: number, body: unknown): void {
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { "content-type": "application/json" },
  });
  out.write(JSON.stringify(body));
  out.end();
}

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if (event.requestContext.http.method !== "POST") {
    return respond(stream, 405, { error: "method not allowed" });
  }

  const user = await authenticate(event);
  if (!user) return respond(stream, 401, { error: "unauthorized" });

  let input: { message?: unknown; session_id?: unknown; max_tokens?: unknown; harness?: unknown };
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    input = JSON.parse(raw);
  } catch {
    return respond(stream, 400, { error: "body must be JSON" });
  }

  const { message } = input;
  if (typeof message !== "string" || !message || message.length > MAX_MESSAGE_CHARS) {
    return respond(stream, 400, { error: `message must be 1-${MAX_MESSAGE_CHARS} characters` });
  }

  const harnessName = typeof input.harness === "string" ? input.harness : DEFAULT_HARNESS;
  const harnessArn = HARNESSES[harnessName];
  if (!harnessArn) {
    return respond(stream, 400, { error: `unknown harness, choose one of: ${Object.keys(HARNESSES).join(", ")}` });
  }

  const sessionId = input.session_id === undefined ? `session-${randomUUID()}` : input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return respond(stream, 400, { error: "session_id must be at least 33 characters of A-Z a-z 0-9 _ -" });
  }

  const requested = typeof input.max_tokens === "number" ? Math.floor(input.max_tokens) : 1000;
  const maxTokens = Math.min(Math.max(requested, 1), MAX_TOKENS_CAP);

  let response;
  try {
    response = await clientFor(harnessArn).send(
      new InvokeHarnessCommand({
        harnessArn,
        runtimeSessionId: sessionId,
        messages: [{ role: "user", content: [{ text: message }] }],
        maxTokens,
        timeoutSeconds: 120,
      }),
    );
  } catch (err) {
    console.error("InvokeHarness failed", err);
    return respond(stream, 502, { error: "harness invocation failed" });
  }

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "x-session-id": sessionId },
  });
  try {
    for await (const ev of response.stream ?? []) {
      if ("contentBlockDelta" in ev && ev.contentBlockDelta) {
        const delta = ev.contentBlockDelta.delta;
        if (delta && "text" in delta && delta.text) out.write(delta.text);
      } else if ("internalServerException" in ev || "validationException" in ev || "runtimeClientError" in ev) {
        console.error("harness stream error event", JSON.stringify(ev));
        out.write("\n[error: the harness reported an error]");
        break;
      }
    }
  } catch (err) {
    console.error("harness stream failed", err);
    out.write("\n[error: stream interrupted]");
  }
  out.end();
});
