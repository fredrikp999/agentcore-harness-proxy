// Calls the proxy on the same origin. Cloudflare Access adds the JWT from the CF_Authorization
// cookie, so the browser holds no credentials of its own.

/** The Access session has expired: Access answers with a redirect to its login page. */
export class SignInRequired extends Error {}
export class ApiError extends Error {}

export interface Config {
  harnesses: string[];
  default: string;
  user: string;
}

export interface ChatRequest {
  message: string;
  session_id: string;
  harness: string;
  max_tokens: number;
}

async function check(res: Response): Promise<Response> {
  // redirect: "manual" turns the Access login redirect into an opaque response instead of following it.
  if (res.type === "opaqueredirect" || res.status === 401) throw new SignInRequired("sign-in required");
  if (!res.ok) {
    let message = `request failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Not JSON, e.g. an error page from Cloudflare; keep the status message.
    }
    throw new ApiError(message);
  }
  return res;
}

export async function fetchConfig(): Promise<Config> {
  const res = await check(await fetch("/api/harnesses", { redirect: "manual" }));
  return res.json();
}

/** Yields the reply text as it streams in. */
export async function* streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<string> {
  const res = await check(
    await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    }),
  );
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}
