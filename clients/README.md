# Clients

Two scripts that send a message to the agent and stream the reply to your
terminal. Run them with [uv](https://docs.astral.sh/uv/) (`brew install uv`);
each declares its own dependencies, and `uv run` creates a cached environment on
first use. Both read settings from the git-ignored `.env` at the repository root,
wherever you run them from.

| Script | Calls | Needs |
|---|---|---|
| [`invoke_harness.py`](invoke_harness.py) | The harness directly (`InvokeHarness`, SigV4) | AWS credentials and `HARNESS_ARN` |
| [`invoke_proxy.py`](invoke_proxy.py) | The Cloudflare Access proxy | A Cloudflare service token, no AWS credentials |
| [`mcp_proxy.py`](mcp_proxy.py) | The proxy's MCP endpoint, `/api/mcp` | A Cloudflare service token, no AWS credentials |

```sh
cp .env.example .env     # at the repository root, then fill in the values
chmod 600 .env           # never commit it
```

## Directly with AWS credentials

```sh
uv run clients/invoke_harness.py "Hello, who are you?"
```

| Option | Description |
|---|---|
| `--harness-arn ARN` | Harness to call. Default: `HARNESS_ARN` from `.env`. The region is read from the ARN. |
| `--session-id ID` | Reuse a session id to continue a conversation. Must be at least 33 characters. Default: a new random id per run. |
| `--max-tokens N` | Maximum output tokens. Default: 1000. |

```sh
# Continue a conversation
uv run clients/invoke_harness.py --session-id my-test-session-0000000000000000001 "Remember the number 7"
uv run clients/invoke_harness.py --session-id my-test-session-0000000000000000001 "What number did I say?"
```

The reply streams to stdout. The session id and token count are printed to
stderr, so you can pipe the reply without them. The script depends on
`boto3[crt]>=1.42`: 1.42 is the first version with the harness API, and `crt` is
needed for `aws login` credentials.

### AWS credentials

The identity needs `bedrock-agentcore:InvokeHarness` and
`bedrock-agentcore:InvokeAgentRuntime` on the harness. Use one of these, with
region `eu-west-1`:

- **`aws login`** (recommended): signs the CLI in with your AWS console session,
  so no keys are stored on disk. It needs AWS CLI 2.32 or later (`aws --version`;
  upgrade with the installer at `https://awscli.amazonaws.com/AWSCLIV2.pkg`). The
  session lasts up to 12 hours; run `aws login` again when it expires.
- **`aws configure`** with access keys of an IAM user: in the IAM console open
  the user, then **Security credentials**, then **Create access key** (use case
  *Command Line Interface*). The keys go in `~/.aws/credentials`.
- **`aws configure sso`** if the account uses IAM Identity Center. The start URL
  is the **AWS access portal URL** on the Identity Center dashboard.

Check that your credentials work with `aws sts get-caller-identity`. Deploying
the stacks in [`../aws`](../aws/README.md#deploy) needs more rights than calling
the harness.

## Through the proxy

Needs no AWS credentials and only the Python standard library.

```sh
uv run clients/invoke_proxy.py "Hello, who are you?"
uv run clients/invoke_proxy.py --session-id my-test-session-0000000000000000001 "Remember 7"
uv run clients/invoke_proxy.py --harness managed "Hello"
```

## Over MCP

[`mcp_proxy.py`](mcp_proxy.py) calls the `ask_agent` tool on `/api/mcp`, the
same way an MCP client such as Claude Code does. It uses the same `.env`
settings as `invoke_proxy.py`. It prints the reply once the agent is done, not
as it streams, and prints the session id to stderr.

```sh
uv run clients/mcp_proxy.py --list
uv run clients/mcp_proxy.py "Remember the number 7"
uv run clients/mcp_proxy.py --session-id <id printed above> "What number did I say?"
```

To add the agent to an MCP client, see [MCP](../aws/README.md#mcp).

## Values for `.env`

`.env.example` has the same notes next to each setting.

| Setting | Where to find it |
|---|---|
| `HARNESS_ARN` | The `HarnessArn` output of the `AgentHarness` stack, or the harness in the Amazon Bedrock AgentCore console. It looks like `arn:aws:bedrock-agentcore:<region>:<account-id>:harness/<harness-id>`, with no `/harness-endpoint/...` suffix. Only `invoke_harness.py` uses it. |
| `PROXY_URL` | The public hostname you gave the Cloudflare Access application and the Worker's custom domain (the `routes` pattern in `cloudflare/worker/wrangler.jsonc`), as `https://<hostname>/`. |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Zero Trust, then Access controls, then Service credentials, then Service Tokens. Create a token and copy its **Client ID**. It ends in `.access`. |
| `CF_ACCESS_CLIENT_SECRET` | Shown only once, when you create the token. If you lost it, use **Refresh** on the token to get a new one, and update `.env`. |

The service token only works if a policy on the Access application has the action
**Service Auth** and includes that token. A token inside an **Allow** policy is
rejected. Treat the client secret like a password: keep it in a password manager,
keep `.env` at mode `600`, and never commit or paste it into chat. Create one
token per client so you can revoke one without breaking the others.

## Troubleshooting

For the proxy (`invoke_proxy.py`, Cloudflare, the Worker and the Lambda) see
[`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md). For direct calls with
`invoke_harness.py`:

- **`Invalid harness ARN format`:** `HARNESS_ARN` is an endpoint ARN. Remove the
  `/harness-endpoint/DEFAULT` suffix.
- **`Missing Dependency ... botocore[crt]`:** an old cached environment. Run
  `uv cache clean boto3` and try again.
- **`AccessDeniedException` mentioning AWS Marketplace:** the model isn't enabled
  for the account yet. Enable it in the Bedrock console (model catalog), wait
  about 5 minutes and retry.
- **`AccessDeniedException` on `InvokeHarness`:** your credentials lack
  `bedrock-agentcore:InvokeHarness` on the harness. If the message names
  `bedrock-agentcore:InvokeAgentRuntime` on the harness ARN, grant that action
  too.
- **`Unknown operation` or a missing method:** boto3 is too old. Run
  `uv cache clean boto3` and try again.
- **Session id error:** `--session-id` must be at least 33 characters.
