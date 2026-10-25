interface Env {
  /** Lambda function URL origin, e.g. "https://<id>.lambda-url.eu-west-1.on.aws". */
  ORIGIN: string;
}

// Forwards requests that Cloudflare Access has already admitted to the Lambda function URL.
// fetch() sets the Host header from the target URL, which is what the function URL requires.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let origin: string;
    try {
      origin = new URL(env.ORIGIN).origin;
    } catch {
      console.error("ORIGIN is missing or not a URL; deploy with --var ORIGIN:https://<function-url-host>");
      return new Response("proxy misconfigured", { status: 500 });
    }

    const url = new URL(request.url);
    // Concatenate onto the origin instead of resolving against it: a path like "//evil.example/x"
    // would otherwise be read as a protocol-relative URL and send the request to another host.
    const target = new URL(origin + url.pathname + url.search);
    if (target.origin !== origin) return new Response("bad request", { status: 400 });

    const headers = new Headers(request.headers);
    // The Lambda only needs the Access JWT; don't pass the service token on.
    headers.delete("cf-access-client-id");
    headers.delete("cf-access-client-secret");

    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (err) {
      console.error("upstream fetch failed", String(err));
      return new Response("upstream unavailable", { status: 502 });
    }
  },
};
