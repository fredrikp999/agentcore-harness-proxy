#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Send a message to the harness through the Cloudflare Access proxy and stream the reply.

Usage:
    uv run invoke_proxy.py "Hello, who are you?"
    uv run invoke_proxy.py --session-id my-test-session-0000000000000000001 "Remember 7"

Settings come from the environment or a .env file next to this script:
    PROXY_URL                 e.g. https://agenthelper.example.com/
    CF_ACCESS_CLIENT_ID       the service token's Client ID (ends in .access)
    CF_ACCESS_CLIENT_SECRET   the service token's Client Secret
"""
import argparse
import codecs
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


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


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("message", help="text to send to the harness")
    parser.add_argument("--url", help="proxy URL (default: $PROXY_URL)")
    parser.add_argument("--harness", help="harness name (default: the proxy's default)")
    parser.add_argument("--session-id", help="reuse a session id (at least 33 characters)")
    parser.add_argument("--max-tokens", type=int, help="maximum output tokens")
    args = parser.parse_args()

    load_dotenv(Path(__file__).with_name(".env"))
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

    body = {"message": args.message}
    if args.harness:
        body["harness"] = args.harness
    if args.session_id:
        body["session_id"] = args.session_id
    if args.max_tokens:
        body["max_tokens"] = args.max_tokens

    request = urllib.request.Request(
        urllib.parse.urljoin(url, "/api/chat"),
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            # Cloudflare's Browser Integrity Check rejects urllib's default User-Agent (error 1010).
            "user-agent": "invoke-proxy/1.0",
            "CF-Access-Client-Id": client_id,
            "CF-Access-Client-Secret": client_secret,
        },
    )
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

    # Decode incrementally so multi-byte characters split across chunks stay intact.
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    with response:
        while chunk := response.read1(1024):
            sys.stdout.write(decoder.decode(chunk))
            sys.stdout.flush()
        sys.stdout.write(decoder.decode(b"", final=True) + "\n")
    print(f"session: {response.headers.get('x-session-id')}", file=sys.stderr)


if __name__ == "__main__":
    main()
