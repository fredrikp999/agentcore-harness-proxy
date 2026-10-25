# Harness proxy (Lambda + Cloudflare Access)

A Lambda function URL that streams replies from the AgentCore harnesses. It is
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
   cp deploy.local.example.json deploy.local.json   # fill in the three settings
   npx cdk deploy
   ```

   `deploy.local.json` holds `accessTeamDomain`, `accessAud` and `harnessArns`
   (name -> harness ARN; the first name is the default harness). Any of them can
   also be given as `-c key=value`, which wins over the file.

   The `FunctionUrl` output is the origin, e.g.
   `https://abc123.lambda-url.eu-west-1.on.aws/`.
3. Deploy the edge Worker. Lambda rejects requests whose Host header isn't the
   function URL's own host. Rewriting Host with an Origin Rule needs the
   Enterprise plan, so a small Worker forwards requests instead (`fetch` sets
   Host from the target URL):

   ```sh
   cd worker
   cp wrangler.example.jsonc wrangler.jsonc   # set your hostname and the function URL
   npx wrangler login   # once
   npx wrangler deploy
   ```

   The Worker is attached to your hostname as a custom domain, which creates the
   DNS record itself. Delete any existing CNAME for that name first. Cloudflare
   Access must protect that hostname, so the Worker only sees requests that
   already carry a valid token.

## Use

From the repository root, `uv run invoke_proxy.py "Hello"` does this with your
service token from `.env` (see the main README). With `curl`:

```sh
curl -N https://<your-hostname>/ \
  -H "CF-Access-Client-Id: <id>.access" \
  -H "CF-Access-Client-Secret: <secret>" \
  -d '{"message": "Hello, who are you?"}'
```

Request body (JSON, `POST`):

| Field | Description |
|---|---|
| `message` | Required, up to 20,000 characters. |
| `session_id` | Optional, at least 33 characters of `A-Za-z0-9_-`. Reuse it to continue a conversation. The reply's `x-session-id` header returns the id used. |
| `harness` | Optional: a name from `harnessArns` (default: the first one). |
| `max_tokens` | Optional, default 1000, capped at 8000. |

The reply streams back as plain text. Errors before streaming starts are JSON
with a 4xx/5xx status.

## Notes

- The function URL is public. Access is enforced inside the Lambda by the JWT
  check. Requests without a valid token get a 401, so don't remove that check.
- The IAM role may only call `bedrock-agentcore:InvokeHarness` and
  `bedrock-agentcore:InvokeAgentRuntime` (which `InvokeHarness` is also checked
  against) on the harness ARNs in `bin/app.ts`.
- Check the stack with `npx cdk synth -c accessTeamDomain=x -c accessAud=y`.
- After `cdk deploy`, wait for the success line before testing. The deployed
  settings are in `cdk.out/HarnessProxy.template.json`.
- Errors and fixes from the first setup are in
  [`../docs/TROUBLESHOOTING.md`](../docs/TROUBLESHOOTING.md).
