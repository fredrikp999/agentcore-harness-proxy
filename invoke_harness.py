#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["boto3[crt]>=1.42"]
# ///
"""Send a message to an AgentCore harness and stream the reply.

Usage:
    uv run invoke_harness.py "Hello, who are you?"
    uv run invoke_harness.py --harness-arn <arn> "Your message"

Uses the default AWS credentials (~/.aws/credentials). The region is taken
from the harness ARN. The default ARN is HARNESS_ARN, from the environment or
from a .env file next to this script.
"""
import argparse
import os
import sys
import uuid
from pathlib import Path

import boto3


def load_dotenv(path: Path) -> None:
    """Read KEY=value lines into os.environ without overriding variables already set."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def main():
    load_dotenv(Path(__file__).with_name(".env"))
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("message", help="text to send to the harness")
    parser.add_argument(
        "--harness-arn",
        default=os.environ.get("HARNESS_ARN"),
        help="harness to call (default: $HARNESS_ARN)",
    )
    parser.add_argument(
        "--session-id",
        default=None,
        help="reuse a session id to continue a conversation (min 33 chars)",
    )
    parser.add_argument("--max-tokens", type=int, default=1000)
    args = parser.parse_args()
    if not args.harness_arn:
        parser.error("set HARNESS_ARN in .env or pass --harness-arn")

    region = args.harness_arn.split(":")[3]
    session_id = args.session_id or f"test-session-{uuid.uuid4()}"

    client = boto3.client("bedrock-agentcore", region_name=region)
    response = client.invoke_harness(
        harnessArn=args.harness_arn,
        runtimeSessionId=session_id,
        messages=[{"role": "user", "content": [{"text": args.message}]}],
        maxTokens=args.max_tokens,
        timeoutSeconds=120,
    )

    for event in response["stream"]:
        if "contentBlockDelta" in event:
            print(event["contentBlockDelta"]["delta"].get("text", ""), end="", flush=True)
        elif "metadata" in event:
            usage = event["metadata"].get("usage", {})
            print(f"\n\n[session {session_id}, tokens: {usage.get('totalTokens')}]", file=sys.stderr)
    print()


if __name__ == "__main__":
    main()
