# AWS (CDK)

This CDK app has two stacks, both in eu-west-1:

- **`AgentHarness`**: the AgentCore harness built from [`../agent`](../agent/README.md),
  and its execution role. See [The harness stack](#the-harness-stack).
- **`HarnessProxy`**: a Lambda function URL in front of the harness, which
  [`../cloudflare`](../cloudflare/README.md) puts behind Cloudflare Access. It
  reads the harness ARN from an SSM parameter that `AgentHarness` writes.

The Lambda (`lambda/handler.ts`) streams replies from the harness. Every request
must carry a valid `Cf-Access-Jwt-Assertion` header, which the Lambda verifies
against your Cloudflare team's keys. It calls `InvokeHarness` with its own IAM
role, so there are no stored AWS keys.

```
client -> <your-hostname> (Cloudflare Access + Worker) -> Lambda function URL -> InvokeHarness
```

## Deploy

You need AWS credentials with rights to deploy (see
[AWS credentials](../clients/README.md#aws-credentials)), and the Cloudflare
Access application from [`../cloudflare`](../cloudflare/README.md#1-access-application),
so you have its AUD tag and team domain.

Run `npx cdk bootstrap` once if the account has never used CDK in eu-west-1. Then:

```sh
cd aws
npm install
cp deploy.local.example.json deploy.local.json   # fill in the settings
npx cdk deploy --all    # AgentHarness first, then HarnessProxy
```

`deploy.local.json` is git-ignored and holds `accessTeamDomain` and `accessAud`
(required), and optionally `harnessArns`. Any setting can also be given as
`-c key=value`, which wins over the file. The agent itself is defined in the
committed [`../agent/agent.ts`](../agent/agent.ts), not here. You can deploy one
stack alone with `npx cdk deploy AgentHarness` or `npx cdk deploy HarnessProxy`.

The `FunctionUrl` output is the origin for the Cloudflare Worker, e.g.
`https://abc123.lambda-url.eu-west-1.on.aws/`. Continue with
[deploying the Worker](../cloudflare/README.md#2-worker-and-web-ui).

## The proxy API

[`../clients/invoke_proxy.py`](../clients/README.md#through-the-proxy) calls it
with a service token from `.env`. With `curl`:

```sh
curl -N https://<your-hostname>/api/chat \
  -H "CF-Access-Client-Id: <id>.access" \
  -H "CF-Access-Client-Secret: <secret>" \
  -d '{"message": "Hello, who are you?"}'
```

`POST /api/chat` request body (JSON):

| Field | Description |
|---|---|
| `message` | Required, up to 20,000 characters. |
| `session_id` | Optional, at least 33 characters of `A-Za-z0-9_-`. Reuse it to continue a conversation. The reply's `x-session-id` header returns the id used. |
| `harness` | Optional: a name from `harnessArns` (default: the first one). |
| `max_tokens` | Optional, default 1000, capped at 8000. |

The reply streams back as plain text. Errors before streaming starts are JSON
with a 4xx/5xx status.

`GET /api/harnesses` returns the harness names (not their ARNs), the default and
the caller's identity: `{"harnesses": ["managed"], "default": "managed", "user": "you@example.com"}`.
Any other path or method gets a 404.

## The harness stack

`AgentHarness` creates an IAM execution role for the harness, the harness
(`AWS::BedrockAgentCore::Harness`) and an SSM parameter
`/agent-harness/<name>/arn` holding its ARN. The proxy reads that parameter when
it is deployed, so deploy `AgentHarness` first (`--all` does). An SSM parameter
is used instead of a CloudFormation export because an export cannot change while
another stack uses it, which would block replacing the harness.

`lib/agent-harness-stack.ts` reads the agent from `../agent/agent.ts` and
`../agent/system-prompt.md`, and adds, for each enabled tool, its tool entry and
IAM statement. To change the agent, see [`../agent`](../agent/README.md#making-changes).

The role is based on the policy the AgentCore console generates, without the
parts for features this harness does not use (file systems, memory). The
statements for the AWS-managed Code Interpreter and Browser are added only when
those tools are enabled. If the runtime fails to start after a change, compare
with a console-generated policy.

### Moving from a harness created in the console

A harness created by hand is not managed by this stack. To switch:

1. Put the old harness under `harnessArns` in `deploy.local.json`
   (`{"old": "<its ARN>"}`) so the proxy keeps serving it, and run
   `npx cdk deploy --all`. The new harness is offered under the name `managed`
   (`harnessAlias`), and the old one stays the default.
2. Test the new one: `uv run clients/invoke_proxy.py --harness managed "Hello"`.
3. Remove `harnessArns` from `deploy.local.json` and run
   `npx cdk deploy HarnessProxy`. `managed` is now the default.
4. Set `HARNESS_ARN` in `.env` to the new ARN (the `HarnessArn` output), then
   delete the old harness in the console.

## Notes

- The function URL is public. Access is enforced inside the Lambda by the JWT
  check. Requests without a valid token get a 401, so don't remove that check.
- The Lambda's IAM role may only call `bedrock-agentcore:InvokeHarness` and
  `bedrock-agentcore:InvokeAgentRuntime` (which `InvokeHarness` is also checked
  against) on the harness ARNs the proxy is configured with (the managed
  harness, plus any listed under `harnessArns`).
- Check the stacks with `npx cdk synth -c accessTeamDomain=x -c accessAud=y`.
- After `cdk deploy`, wait for the success line before testing. The deployed
  settings are in `cdk.out/HarnessProxy.template.json`.
- Errors and fixes from the first setup are in
  [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md).
