#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Call the agent through the proxy's MCP endpoint (/api/mcp) and print the reply.

Usage:
    uv run clients/mcp_proxy.py --list
    uv run clients/mcp_proxy.py "Hello, who are you?"
    uv run clients/mcp_proxy.py --session-id session-... "What did I just ask?"
    uv run clients/mcp_proxy.py --trace "Use Python to compute 17**13"

Settings come from the environment or the .env file at the repository root:
    PROXY_URL                 e.g. https://agenthelper.example.com/
    CF_ACCESS_CLIENT_ID       the service token's Client ID (ends in .access)
    CF_ACCESS_CLIENT_SECRET   the service token's Client Secret
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROTOCOL_VERSION = "2025-06-18"


def load_dotenv(path: Path) -> None:
    """Read KEY=value lines into os.environ without overriding variables already set."""
    if not path.is_file():
        return
    if path.stat().st_mode & 0o077:
        print(f"warning: {path} is readable by others; run: chmod 600 {path}", file=sys.stderr)
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)


def post(url: str, headers: dict, message: dict):
    """POST one JSON-RPC message; return the JSON-RPC response, or None for a 202."""
    request = urllib.request.Request(url, data=json.dumps(message).encode(), method="POST", headers=headers)
    try:
        response = opener.open(request, timeout=160)
    except urllib.error.HTTPError as err:
        if err.code in (301, 302, 303, 307, 308):
            sys.exit(
                f"error: HTTP {err.code}, redirected to {err.headers.get('location', '?').split('?')[0]}\n"
                "Cloudflare Access did not accept the service token. Check the Client ID and "
                "secret, and that a Service Auth policy on the application includes this token."
            )
        detail = err.read().decode(errors="replace")[:500]
        sys.exit(f"error: HTTP {err.code} {err.reason}\n{detail}")
    except urllib.error.URLError as err:
        sys.exit(f"error: {err.reason}")

    with response:
        if not response.headers.get("content-type", "").startswith("text/event-stream"):
            # A notification gets 202 with no body (an older proxy sent 200 with no body).
            body = response.read()
            return json.loads(body) if body.strip() else None
        # SSE: skip the keepalive comments and return the first message event's data.
        data = []
        for raw in response:
            line = raw.decode().rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif not line and data:
                return json.loads("\n".join(data))
    sys.exit("error: the response ended without a JSON-RPC message")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("message", nargs="?", help="text to send to the agent")
    parser.add_argument("--list", action="store_true", help="list the server's tools and exit")
    parser.add_argument("--url", help="proxy URL (default: $PROXY_URL)")
    parser.add_argument("--harness", help="harness name (default: the proxy's default)")
    parser.add_argument("--session-id", help="continue a conversation (the session_id of an earlier reply)")
    parser.add_argument("--max-tokens", type=int, help="maximum output tokens")
    parser.add_argument("--trace", action="store_true", help="also print the agent's reasoning and tool calls")
    args = parser.parse_args()
    if not args.list and not args.message:
        parser.error("give a message, or --list")

    # .env lives at the repository root, one level up.
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    url = args.url or os.environ.get("PROXY_URL")
    client_id = os.environ.get("CF_ACCESS_CLIENT_ID")
    client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET")
    missing = [
        name
        for name, value in [
            ("PROXY_URL", url),
            ("CF_ACCESS_CLIENT_ID", client_id),
            ("CF_ACCESS_CLIENT_SECRET", client_secret),
        ]
        if not value
    ]
    if missing:
        sys.exit(f"error: missing {', '.join(missing)} (set it in the environment or .env)")

    endpoint = urllib.parse.urljoin(url, "/api/mcp")
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        # Cloudflare's Browser Integrity Check rejects urllib's default User-Agent (error 1010).
        "user-agent": "mcp-proxy/1.0",
        "CF-Access-Client-Id": client_id,
        "CF-Access-Client-Secret": client_secret,
    }

    init = post(endpoint, headers, {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "mcp_proxy.py", "version": "1.0"},
        },
    })
    if "error" in init:
        sys.exit(f"error: initialize failed: {init['error']['message']}")
    headers["mcp-protocol-version"] = init["result"]["protocolVersion"]
    post(endpoint, headers, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    if args.list:
        tools = post(endpoint, headers, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        print(json.dumps(tools["result"]["tools"], indent=2))
        return

    arguments = {"message": args.message}
    if args.harness:
        arguments["harness"] = args.harness
    if args.session_id:
        arguments["session_id"] = args.session_id
    if args.max_tokens:
        arguments["max_tokens"] = args.max_tokens
    if args.trace:
        arguments["include_trace"] = True
    response = post(endpoint, headers, {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "ask_agent", "arguments": arguments},
    })
    if "error" in response:
        sys.exit(f"error: {response['error']['message']}")
    result = response["result"]
    if result.get("isError"):
        sys.exit(f"error: {result['content'][0]['text']}")
    content = result["structuredContent"]
    # The trace goes to stderr, like the session id, so stdout stays just the reply.
    for item in content.get("trace", []):
        if item["type"] == "thinking":
            print(f"[thinking] {item['text']}", file=sys.stderr)
        elif item["type"] == "tool_use":
            print(f"[tool call] {item['tool']} {json.dumps(item['input'])}", file=sys.stderr)
        else:
            print(f"[tool result] {item['tool']} ({item['status']}): {item['output']}", file=sys.stderr)
    print(content["reply"])
    print(f"session: {content['session_id']}", file=sys.stderr)


if __name__ == "__main__":
    main()
