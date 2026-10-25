# Harness and proxy (CDK, Lambda, Cloudflare Access)

This CDK app has two stacks:

- **`AgentHarness`**: the AgentCore harness itself and its execution role. See
  [The harness stack](#the-harness-stack).
- **`HarnessProxy`**: a Lambda function URL in front of the harness, plus the
  edge Worker in `worker/`. It reads the harness ARN from an SSM parameter that
  `AgentHarness` writes.

The proxy is a Lambda function URL that streams replies from the AgentCore harnesses. It is
meant to sit behind Cloudflare Access: every request must carry a valid
`Cf-Access-Jwt-Assertion` header, which the Lambda verifies against your
team's keys. The Lambda calls `InvokeHarness` with its own IAM role, so there
are no stored AWS keys.

```
client -> <your-hostname> (Cloudflare Access + Worker) -> Lambda function URL -> InvokeHarness
```

## Deploy

Real values (hostname, Access settings, harness ARNs with the account id) stay
out of the repository. They go in two git-ignored files, each copied from an
`*.example` file.

1. Create the Access application first, so you have its values:
   - Zero Trust -> Access -> Applications -> Add -> Self-hosted, with your
     hostname, an Allow policy for you and a **separate** policy for a service
     token whose action is **Service Auth**. A service token under an Allow policy
     is not accepted.
   - Note the **Application Audience (AUD) tag** and your **team domain**
     (`<team>.cloudflareaccess.com`).
2. Deploy the stack (region eu-west-1; run `npx cdk bootstrap` once if the account
   has never used CDK there):

   ```sh
   cd infra
   npm install
   cp deploy.local.example.json deploy.local.json   # fill in the settings
   npx cdk deploy --all    # AgentHarness first, then HarnessProxy
   ```

   `deploy.local.json` holds `accessTeamDomain` and `accessAud` (required), and
   optionally `harnessArns`. Any setting can also be given as `-c key=value`,
   which wins over the file. The harness itself is defined in the committed
   `harness/agent.ts`, not here (see [The harness stack](#the-harness-stack)). You can deploy one stack
   alone with `npx cdk deploy AgentHarness` or `npx cdk deploy HarnessProxy`.

   The `FunctionUrl` output is the origin, e.g.
   `https://abc123.lambda-url.eu-west-1.on.aws/`.
3. Deploy the edge Worker. Lambda rejects requests whose Host header isn't the
   function URL's own host. Rewriting Host with an Origin Rule needs the
   Enterprise plan, so a small Worker forwards requests instead (`fetch` sets
   Host from the target URL):

   ```sh
   (cd ../web && npm install && npm run build)   # the web UI, into worker/public
   cd worker
   cp wrangler.example.jsonc wrangler.jsonc   # set your hostname and the function URL
   npx wrangler login   # once
   npx wrangler deploy
   ```

   In `wrangler.jsonc`, set `routes[0].pattern` to your hostname and
   `vars.ORIGIN` to the `FunctionUrl` output without the trailing slash. If
   `ORIGIN` is left as the `<function-url-host>` placeholder, every `/api/*` call
   fails with `500 proxy misconfigured`; in the web UI that shows as
   `request failed (HTTP 500)` and an empty Harness list.

   The Worker serves the web UI from `worker/public` and forwards only `/api/*`
   to the Lambda. Rebuild the UI before each deploy that should include UI changes.
   If `/` returns `{"error":"not found"}` instead of the page, the deployed Worker
   is older than the UI and still forwards every path to the Lambda: build the
   UI and run `npx wrangler deploy` again.

   The Worker is attached to your hostname as a custom domain, which creates the
   DNS record itself. Delete any existing CNAME for that name first. Cloudflare
   Access must protect that hostname, so the Worker only sees requests that
   already carry a valid token.

## Use

From the repository root, `uv run invoke_proxy.py "Hello"` does this with your
service token from `.env` (see the main README). With `curl`:

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
`/agent-harness/<name>/arn` holding its ARN. The proxy reads that
parameter when it is deployed, so deploy `AgentHarness` first (`--all` does).
An SSM parameter is used instead of a CloudFormation export because an export
cannot change while another stack uses it, which would block replacing the
harness.

The agent is defined in two committed files, and the stack derives the rest:

| File | Holds |
|---|---|
| `harness/agent.ts` | Name, model, tools, `allowedTools` and limits. Type-checked against `AgentConfig` in the stack. |
| `harness/system-prompt.md` | The system prompt. |
| `lib/agent-harness-stack.ts` | How AWS provides it: the harness, the execution role and, for each enabled tool, its tool entry and IAM statement. |

Secrets never go in `agent.ts`. An MCP server that needs a key should get it
from an AgentCore Identity credential provider, added to the stack together with
the IAM to read it.

- **Change the prompt or the agent:** edit the file and run
  `npx cdk diff AgentHarness`, then `npx cdk deploy AgentHarness`.
- **Change the model:** set `model` in `harness/agent.ts`. The role's Bedrock
  permission follows the model id. To try a model for one deploy without editing
  the file, pass `-c modelId=<id>`.
- **Add a tool:** set `codeInterpreter` or `browser` to `true`, or add
  `{ name, url }` to `mcpServers`. The stack adds the matching IAM statement.
  `allowedTools` (`"*"` by default) also allows the built-in `shell` and
  `file_operations` tools.
- **Rename the harness:** `name` cannot change in place. CloudFormation
  creates a new harness with a new ARN and deletes the old one, which ends its
  sessions. Redeploy `HarnessProxy` afterwards so it picks up the new ARN.
- **The role** is based on the policy the AgentCore console generates, without
  the parts for features this harness does not use (file systems, memory). The
  statements for the AWS-managed Code Interpreter and Browser are added only
  when those tools are enabled. If the runtime fails to start after a change, compare
  with a console-generated policy.

### Moving from a harness created in the console

A harness created by hand is not managed by this stack. To switch:

1. Put the old harness under `harnessArns` in `deploy.local.json`
   (`{"old": "<its ARN>"}`) so the proxy keeps serving it, and run
   `npx cdk deploy --all`. The new harness is offered under the name `managed`
   (`harnessAlias`), and the old one stays the default.
2. Test the new one: `uv run invoke_proxy.py --harness managed "Hello"`.
3. Remove `harnessArns` from `deploy.local.json` and run
   `npx cdk deploy HarnessProxy`. `managed` is now the default.
4. Set `HARNESS_ARN` in `.env` to the new ARN (the `HarnessArn` output), then
   delete the old harness in the console.

## Notes

- The function URL is public. Access is enforced inside the Lambda by the JWT
  check. Requests without a valid token get a 401, so don't remove that check.
- The IAM role may only call `bedrock-agentcore:InvokeHarness` and
  `bedrock-agentcore:InvokeAgentRuntime` (which `InvokeHarness` is also checked
  against) on the harness ARNs the proxy is configured with (the managed harness, plus
  any listed under `harnessArns`).
- Check the stack with `npx cdk synth -c accessTeamDomain=x -c accessAud=y`.
- After `cdk deploy`, wait for the success line before testing. The deployed
  settings are in `cdk.out/HarnessProxy.template.json`.
- Errors and fixes from the first setup are in
  [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md).
