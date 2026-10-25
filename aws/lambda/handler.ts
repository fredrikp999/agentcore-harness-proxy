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

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

/** Length of the longest end of `text` that is the start of `tag`, i.e. a tag split across chunks. */
function partialTagLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/** One piece of the agent's turn, in the order it happened. */
type ReplyPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; tool: string; input: string }
  | { type: "tool_result"; id: string; status: string; output: string };

/**
 * Moves <thinking>...</thinking> blocks out of the text parts into thinking parts, and drops the
 * whitespace before the first visible text. Nova models write their reasoning in these tags even
 * when the prompt says not to.
 */
async function* splitThinking(parts: AsyncIterable<ReplyPart>): AsyncGenerator<ReplyPart> {
  let buffer = "";
  let thought = "";
  let inside = false;
  let started = false;
  const visible = (text: string): ReplyPart | undefined => {
    const out = started ? text : text.trimStart();
    if (out) started = true;
    return out ? { type: "text", text: out } : undefined;
  };
  for await (const part of parts) {
    if (part.type !== "text") {
      yield part;
      continue;
    }
    buffer += part.text;
    for (;;) {
      const tag = inside ? THINKING_CLOSE : THINKING_OPEN;
      const at = buffer.indexOf(tag);
      if (at >= 0) {
        if (inside) {
          thought += buffer.slice(0, at);
          if (thought.trim()) yield { type: "thinking", text: thought.trim() };
          thought = "";
        } else {
          const before = visible(buffer.slice(0, at));
          if (before) yield before;
        }
        buffer = buffer.slice(at + tag.length);
        inside = !inside;
        continue;
      }
      // Hold back what might be the start of a tag until the next chunk shows.
      const keep = partialTagLength(buffer, tag);
      if (inside) {
        thought += buffer.slice(0, buffer.length - keep);
      } else {
        const ready = visible(buffer.slice(0, buffer.length - keep));
        if (ready) yield ready;
      }
      buffer = buffer.slice(buffer.length - keep);
      break;
    }
  }
  if (inside) {
    // A block that never closed: keep it out of the reply, but in the trace.
    if ((thought + buffer).trim()) yield { type: "thinking", text: (thought + buffer).trim() };
  } else {
    const rest = visible(buffer);
    if (rest) yield rest;
  }
}

/** Starts the harness call (throws if that fails) and returns the agent's turn as it streams. */
async function invokeHarness(req: HarnessRequest): Promise<AsyncGenerator<ReplyPart>> {
  const response = await clientFor(req.harnessArn).send(
    new InvokeHarnessCommand({
      harnessArn: req.harnessArn,
      runtimeSessionId: req.sessionId,
      messages: [{ role: "user", content: [{ text: req.message }] }],
      maxTokens: req.maxTokens,
      timeoutSeconds: 120,
    }),
  );
  return splitThinking((async function* (): AsyncGenerator<ReplyPart> {
    // Tool calls and results arrive as blocks whose content streams in deltas; each is passed on
    // whole when its block stops. So is reasoning from models that return it separately.
    let block: Extract<ReplyPart, { type: "tool_use" | "tool_result" }> | undefined;
    let reasoning = "";
    for await (const ev of response.stream ?? []) {
      if (ev.contentBlockStart?.start) {
        const { toolUse, toolResult } = ev.contentBlockStart.start;
        if (toolUse) block = { type: "tool_use", id: toolUse.toolUseId ?? "", tool: toolUse.name ?? "", input: "" };
        if (toolResult) block = { type: "tool_result", id: toolResult.toolUseId ?? "", status: toolResult.status ?? "", output: "" };
      } else if (ev.contentBlockDelta?.delta) {
        const delta = ev.contentBlockDelta.delta;
        if (delta.text) yield { type: "text", text: delta.text };
        else if (delta.reasoningContent?.text) reasoning += delta.reasoningContent.text;
        else if (delta.toolUse && block?.type === "tool_use") block.input += delta.toolUse.input ?? "";
        else if (delta.toolResult && block?.type === "tool_result") {
          for (const r of delta.toolResult) block.output += r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
        }
      } else if (ev.contentBlockStop) {
        if (reasoning.trim()) yield { type: "thinking", text: reasoning.trim() };
        if (block) yield block;
        reasoning = "";
        block = undefined;
      } else if (ev.internalServerException || ev.validationException || ev.runtimeClientError) {
        console.error("harness stream error event", JSON.stringify(ev));
        throw new HarnessError("the harness reported an error");
      }
    }
  })());
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
    for await (const part of reply) if (part.type === "text") out.write(part.text);
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
      include_trace: {
        type: "boolean",
        description:
          "Also return the agent's reasoning and the tools it called, with their inputs and shortened " +
          "results, in the order it happened. Useful to check how it got an answer. Default: false.",
      },
    },
    required: ["message"],
  },
  outputSchema: {
    type: "object",
    properties: {
      reply: { type: "string" },
      session_id: { type: "string" },
      trace: {
        type: "array",
        description: "Only with include_trace.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["thinking", "tool_use", "tool_result"] },
            text: { type: "string", description: "thinking" },
            tool: { type: "string", description: "tool_use, tool_result" },
            input: { description: "tool_use: the arguments the agent passed" },
            status: { type: "string", description: "tool_result" },
            output: { type: "string", description: "tool_result" },
          },
          required: ["type"],
        },
      },
    },
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
  const args = isObject(params.arguments) ? params.arguments : {};
  const req = parseRequest(args);
  if (typeof req === "string") return respond(stream, 200, rpcResult(id, toolError(req)));
  const includeTrace = args.include_trace === true;

  // Clients must accept SSE; answer with plain JSON for one that doesn't.
  if (!(event.headers?.accept ?? "").includes("text/event-stream")) {
    return respond(stream, 200, rpcResult(id, await askAgent(req, includeTrace)));
  }
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
  out.write(": working\n\n");
  const keepalive = setInterval(() => out.write(": working\n\n"), MCP_KEEPALIVE_MS);
  let result;
  try {
    result = await askAgent(req, includeTrace);
  } finally {
    clearInterval(keepalive);
  }
  out.write(`event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`);
  out.end();
}

// Each trace item's text is cut to this length, so one large tool result can't flood the caller.
const TRACE_ITEM_MAX_CHARS = 2_000;

function clip(text: string): string {
  return text.length > TRACE_ITEM_MAX_CHARS ? `${text.slice(0, TRACE_ITEM_MAX_CHARS)}… [shortened]` : text;
}

/** A tool's input as JSON when it is valid and short enough, else as clipped text. */
function toolInput(input: string): unknown {
  if (!input) return {};
  try {
    return input.length <= TRACE_ITEM_MAX_CHARS ? JSON.parse(input) : clip(input);
  } catch {
    return clip(input);
  }
}

async function askAgent(req: HarnessRequest, includeTrace: boolean) {
  let reply = "";
  const trace: Record<string, unknown>[] = [];
  const toolNames = new Map<string, string>();
  try {
    for await (const part of await invokeHarness(req)) {
      if (part.type === "text") reply += part.text;
      else if (!includeTrace) continue;
      else if (part.type === "thinking") trace.push({ type: "thinking", text: clip(part.text) });
      else if (part.type === "tool_use") {
        toolNames.set(part.id, part.tool);
        trace.push({ type: "tool_use", tool: part.tool, input: toolInput(part.input) });
      } else {
        const tool = toolNames.get(part.id) ?? "";
        trace.push({ type: "tool_result", tool, status: part.status, output: clip(part.output) });
      }
    }
  } catch (err) {
    if (err instanceof HarnessError) return toolError("the harness reported an error");
    console.error("harness call failed", err);
    return toolError("harness invocation failed");
  }
  const structuredContent = includeTrace
    ? { reply, session_id: req.sessionId, trace }
    : { reply, session_id: req.sessionId };
  // The JSON again as text, for clients that only pass content blocks to the model.
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
}
