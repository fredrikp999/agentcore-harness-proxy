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
  rawPath?: string;
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
  const method = event.requestContext.http.method;
  const path = event.rawPath ?? "/";
  if (path === "/api/mcp" && method !== "POST") {
    // No server-initiated SSE stream and no MCP sessions, so GET and DELETE are not offered.
    return respond(stream, 405, { error: "method not allowed" });
  }
  const route = `${method} ${path}`;
  if (route !== "POST /api/chat" && route !== "GET /api/harnesses" && route !== "POST /api/mcp") {
    return respond(stream, 404, { error: "not found" });
  }

  const user = await authenticate(event);
  if (!user) return respond(stream, 401, { error: "unauthorized" });

  if (route === "GET /api/harnesses") {
    // Names only: the ARNs carry the account id and stay server side.
    return respond(stream, 200, { harnesses: Object.keys(HARNESSES), default: DEFAULT_HARNESS, user });
  }
  if (route === "POST /api/mcp") return mcp(event, stream);

  return chat(event, stream);
});

function bodyOf(event: FunctionUrlEvent): string {
  return event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface HarnessRequest {
  harnessArn: string;
  sessionId: string;
  message: string;
  maxTokens: number;
}

/** Validates the fields shared by /api/chat and the MCP tool; returns an error message on bad input. */
function parseRequest(input: Record<string, unknown>): HarnessRequest | string {
  const { message } = input;
  if (typeof message !== "string" || !message || message.length > MAX_MESSAGE_CHARS) {
    return `message must be 1-${MAX_MESSAGE_CHARS} characters`;
  }

  const harnessName = typeof input.harness === "string" ? input.harness : DEFAULT_HARNESS;
  const harnessArn = HARNESSES[harnessName];
  if (!harnessArn) return `unknown harness, choose one of: ${Object.keys(HARNESSES).join(", ")}`;

  const sessionId = input.session_id === undefined ? `session-${randomUUID()}` : input.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return "session_id must be at least 33 characters of A-Z a-z 0-9 _ -";
  }

  const requested = typeof input.max_tokens === "number" ? Math.floor(input.max_tokens) : 1000;
  const maxTokens = Math.min(Math.max(requested, 1), MAX_TOKENS_CAP);
  return { harnessArn, sessionId, message, maxTokens };
}

/** An error event inside the harness stream, as opposed to the stream itself failing. */
class HarnessError extends Error {}

/** Starts the harness call (throws if that fails) and returns the reply's text deltas. */
async function invokeHarness(req: HarnessRequest): Promise<AsyncGenerator<string>> {
  const response = await clientFor(req.harnessArn).send(
    new InvokeHarnessCommand({
      harnessArn: req.harnessArn,
      runtimeSessionId: req.sessionId,
      messages: [{ role: "user", content: [{ text: req.message }] }],
      maxTokens: req.maxTokens,
      timeoutSeconds: 120,
    }),
  );
  return (async function* () {
    for await (const ev of response.stream ?? []) {
      if ("contentBlockDelta" in ev && ev.contentBlockDelta) {
        const delta = ev.contentBlockDelta.delta;
        if (delta && "text" in delta && delta.text) yield delta.text;
      } else if ("internalServerException" in ev || "validationException" in ev || "runtimeClientError" in ev) {
        console.error("harness stream error event", JSON.stringify(ev));
        throw new HarnessError("the harness reported an error");
      }
    }
  })();
}

async function chat(event: FunctionUrlEvent, stream: Writable): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(bodyOf(event));
  } catch {
    return respond(stream, 400, { error: "body must be JSON" });
  }
  const req = parseRequest(isObject(input) ? input : {});
  if (typeof req === "string") return respond(stream, 400, { error: req });

  let reply;
  try {
    reply = await invokeHarness(req);
  } catch (err) {
    console.error("InvokeHarness failed", err);
    return respond(stream, 502, { error: "harness invocation failed" });
  }

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "x-session-id": req.sessionId },
  });
  try {
    for await (const text of reply) out.write(text);
  } catch (err) {
    if (err instanceof HarnessError) {
      out.write("\n[error: the harness reported an error]");
    } else {
      console.error("harness stream failed", err);
      out.write("\n[error: stream interrupted]");
    }
  }
  out.end();
}

// MCP over Streamable HTTP, stateless: every POST carries one JSON-RPC message and needs no
// Mcp-Session-Id. The conversation state is the harness session, returned by the tool.
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MCP_SERVER_INFO = { name: "agentcore-harness-proxy", version: "1.0.0" };
// SSE comments sent while the agent works, so proxies on the way don't time out an idle response.
const MCP_KEEPALIVE_MS = 15_000;

const ASK_AGENT_TOOL = {
  name: "ask_agent",
  title: "Ask the agent",
  description:
    "Send a message to the AgentCore agent and return its full reply. The agent can search AWS " +
    "documentation, read GitHub repositories and run code. To continue the same conversation, " +
    "pass the session_id from the previous result.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", maxLength: MAX_MESSAGE_CHARS, description: "The message to the agent." },
      session_id: {
        type: "string",
        pattern: SESSION_ID_PATTERN.source,
        description: "Continue an earlier conversation. Omit it to start a new one.",
      },
      harness: { type: "string", enum: Object.keys(HARNESSES), description: `Default: ${DEFAULT_HARNESS}.` },
      max_tokens: { type: "integer", minimum: 1, maximum: MAX_TOKENS_CAP, description: "Default: 1000." },
    },
    required: ["message"],
  },
  outputSchema: {
    type: "object",
    properties: { reply: { type: "string" }, session_id: { type: "string" } },
    required: ["reply", "session_id"],
  },
};

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

async function mcp(event: FunctionUrlEvent, stream: Writable): Promise<void> {
  // MCP clients aren't browsers; a request with an Origin is a web page calling with the
  // visitor's Access cookie, which the spec says to refuse.
  if (event.headers?.origin) return respond(stream, 403, rpcError(null, -32600, "browser origins are not allowed"));

  const version = event.headers?.["mcp-protocol-version"];
  if (version && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return respond(stream, 400, rpcError(null, -32600, `unsupported MCP-Protocol-Version: ${version}`));
  }

  let msg: unknown;
  try {
    msg = JSON.parse(bodyOf(event));
  } catch {
    return respond(stream, 400, rpcError(null, -32700, "parse error"));
  }
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return respond(stream, 400, rpcError(null, -32600, "invalid request"));

  // Notifications (no id) and responses (no method) need no reply.
  if (msg.id === undefined || typeof msg.method !== "string") {
    // The status and headers go out with the first write; without one, the function URL
    // replies 200 application/octet-stream instead of 202.
    const out = awslambda.HttpResponseStream.from(stream, { statusCode: 202 });
    out.write("");
    out.end();
    return;
  }
  const id = msg.id as JsonRpcId;
  const params = isObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : MCP_PROTOCOL_VERSIONS[0];
      return respond(
        stream,
        200,
        rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO }),
      );
    }
    case "ping":
      return respond(stream, 200, rpcResult(id, {}));
    case "tools/list":
      return respond(stream, 200, rpcResult(id, { tools: [ASK_AGENT_TOOL] }));
    case "tools/call":
      return callTool(event, stream, id, params);
    default:
      return respond(stream, 200, rpcError(id, -32601, `method not found: ${msg.method}`));
  }
}

async function callTool(
  event: FunctionUrlEvent,
  stream: Writable,
  id: JsonRpcId,
  params: Record<string, unknown>,
): Promise<void> {
  if (params.name !== ASK_AGENT_TOOL.name) {
    return respond(stream, 200, rpcError(id, -32602, `unknown tool: ${String(params.name)}`));
  }
  const req = parseRequest(isObject(params.arguments) ? params.arguments : {});
  if (typeof req === "string") return respond(stream, 200, rpcResult(id, toolError(req)));

  // Clients must accept SSE; answer with plain JSON for one that doesn't.
  if (!(event.headers?.accept ?? "").includes("text/event-stream")) {
    return respond(stream, 200, rpcResult(id, await askAgent(req)));
  }
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
  out.write(": working\n\n");
  const keepalive = setInterval(() => out.write(": working\n\n"), MCP_KEEPALIVE_MS);
  let result;
  try {
    result = await askAgent(req);
  } finally {
    clearInterval(keepalive);
  }
  out.write(`event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`);
  out.end();
}

async function askAgent(req: HarnessRequest) {
  let reply = "";
  try {
    for await (const text of await invokeHarness(req)) reply += text;
  } catch (err) {
    if (err instanceof HarnessError) return toolError("the harness reported an error");
    console.error("harness call failed", err);
    return toolError("harness invocation failed");
  }
  const structuredContent = { reply, session_id: req.sessionId };
  // The JSON again as text, for clients that only pass content blocks to the model.
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}
