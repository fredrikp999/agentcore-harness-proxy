# Setup and design decisions

This document records how the harness proxy was set up and why. It uses
placeholders for account ids, hostnames, tokens and team names. Keep real values
out of this repository.

For day-to-day usage see the [main README](../README.md). For the deploy
commands see [`aws/README.md`](../aws/README.md) and [`cloudflare/README.md`](../cloudflare/README.md). A diagram of the request
path is in [`architecture.html`](architecture.html). Problems met during setup,
with fixes, are in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Goal

Call an AWS AgentCore harness from clients that have no AWS credentials, such as
`curl`, a script, an app or an MCP client, without exposing the harness to the
internet.

The harness can only be called through the `InvokeHarness` API, which needs
SigV4-signed AWS credentials. Handing those credentials to every client would
spread long-lived keys. Instead, one small proxy holds the AWS permission and
callers prove who they are with Cloudflare Access.

## Architecture in one paragraph

```
client -> <your-domain> (Cloudflare Access + Worker) -> Lambda function URL -> InvokeHarness
```

A request goes to a hostname proxied by Cloudflare. Access checks the caller and
attaches a signed JWT. A Worker forwards the request to the Lambda function URL.
The Lambda verifies the JWT, then calls `InvokeHarness` with its own IAM role and
streams the reply back.

## Decisions and why

### Cloudflare Access as the front door

Access handles identity (a login for people, a service token for scripts), so
the proxy does not need its own user database or API keys. Policies are managed
in one place and can be changed without redeploying anything.

### The Lambda checks the JWT too

The Lambda function URL has no IAM auth (`authType: NONE`), so it is reachable
by anyone who knows the address. Cloudflare Access alone would not protect it,
because a caller could skip Cloudflare and hit the function URL directly.

So the Lambda verifies the `Cf-Access-Jwt-Assertion` header on every request
against the team's public keys, and checks the issuer and the application's
audience (AUD) tag. A request without a valid token gets a 401. This check is
the real security boundary. Do not remove it.

### A function URL with response streaming

The harness streams its reply. A function URL in `RESPONSE_STREAM` mode passes
that stream to the client as it arrives. This avoids API Gateway, which adds cost
and buffering, and keeps the setup to one Lambda.

### A Worker that forwards to the function URL

Lambda function URLs reject requests whose `Host` header is not the function
URL's own hostname. Cloudflare forwards the public hostname by default. Rewriting
the Host header with an Origin Rule needs the Enterprise plan, so a small Worker
(`cloudflare/worker/`) makes the request to the function URL instead. `fetch` sets the
Host header from the target URL, and the reply streams straight back.

The Worker also drops the service-token headers, so the Lambda only receives the
signed Access JWT. It contains no auth logic. Access in front of it and the JWT
check in the Lambda do the security work.

### MCP on the same Lambda

`POST /api/mcp` makes the agent an MCP server with one tool, `ask_agent`, so
MCP clients such as Claude Code can use it as a tool. It is a second route in
the same Lambda, not a separate service. It reuses the JWT check, the input
validation and the harness call, and Access and the Worker need no changes.
AgentCore Gateway could serve MCP too, but it would add a second inbound auth
system next to Access and another stack, just to expose one tool.

The endpoint is stateless (no `Mcp-Session-Id`): the conversation is the harness
session, whose id the tool returns. A tool result can't stream, so `tools/call`
answers over SSE, with a comment every 15 seconds while the agent works, then the
whole reply. Requests with an `Origin` header are refused, because only a web
page calling with a visitor's Access cookie would send one.

Clients authenticate with a service token in two headers. claude.ai and Claude
Desktop connectors can't send fixed headers and expect OAuth instead, so they
don't work yet (see the next steps below).

### No stored AWS keys

The Lambda calls AWS with its execution role. There are no access keys in
environment variables, in the repository or on clients.

### The role can only call one thing

The role is allowed `bedrock-agentcore:InvokeHarness` and
`bedrock-agentcore:InvokeAgentRuntime` (`InvokeHarness` is also authorized
against that action) on the harness ARNs the proxy is configured with, and
nothing else beyond writing its own logs. If the function is ever abused, the
damage is limited to calling those harnesses. Granting `InvokeHarness` alone
fails with an `AccessDeniedException` for `InvokeAgentRuntime`.

### The harness is managed here too, as its own stack

A harness is configuration (model, prompt, tools, role), so it is defined in
the repository: the agent in `agent/agent.ts` and `agent/system-prompt.md`, and
how AWS provides it (harness, role, IAM per tool) in
`aws/lib/agent-harness-stack.ts`.
Changes are reviewed in pull requests and can be reproduced. It is a separate
stack from the proxy because the prompt changes far more often than the proxy.
The proxy reads the harness ARN from an SSM parameter, not a CloudFormation
export, so the harness can be replaced without first detaching the proxy. The two
stacks can later move to separate repositories, with the SSM parameter as the
only link between them.

### Infrastructure as code with CDK

The stacks are defined in `aws/` so the setup can be reviewed, repeated and
changed through pull requests. The Worker is deployed with Wrangler. The
Cloudflare Access application is created by hand in the dashboard and is not yet
in code.

### Rate limiting

The function URL is public, so two limits cap what a flood of requests can cost:

- **Cloudflare**, in front: a rate-limiting rule on `/api/*` of the hostname
  (`cloudflare/rate-limit/apply.sh`), 30 requests per 10 seconds per IP by
  default. Blocked requests never reach the Worker or Lambda.
- **Lambda**, behind: reserved concurrency of 10 (`reservedConcurrency`, or
  `"off"`). Excess requests get a 429 from Lambda. Reserving needs the account's
  concurrency limit to stay at 10 or more unreserved, so on a new account with the
  default limit of 10 the deploy fails until you request a quota increase (or set
  `"off"`).

### Automated deploys from GitHub Actions

No deploy keys: GitHub Actions gets short-lived credentials through OIDC.
`aws/github-oidc.template.yaml` is deployed once by an administrator and creates
two roles, both able to do nothing except assume CDK bootstrap roles:

| Role | Trusted for | Can assume | Used by |
|---|---|---|---|
| `github-cdk-deploy` | this repository, GitHub environment `production` only | the CDK deploy, file/image publishing and lookup roles | `.github/workflows/deploy.yml` on push to `main` |
| `github-cdk-diff` | this repository, `pull_request` runs | the CDK lookup role only (read-only) | `.github/workflows/cdk-diff.yml` |

The diff role is read-only because a pull request can change the code that
`cdk synth` runs. Only the protected environment can deploy. Setup:

1. As an administrator: `aws cloudformation deploy --stack-name GithubOidcDeploy
   --template-file aws/github-oidc.template.yaml --capabilities CAPABILITY_NAMED_IAM
   --region eu-west-1 --parameter-overrides GitHubRepo=<owner>/<repo>`. Add
   `CreateOidcProvider=false` if the account already has the GitHub provider. Newer
   GitHub accounts put numeric ids in the token subject; if the login step says "Not
   authorized to perform sts:AssumeRoleWithWebIdentity", print the `sub` claim and add
   `GitHubSubjectRepo=<owner>@<id>/<repo>@<id>` (for example
   `fredrikp999@24974179/agentcore-harness-proxy@1433222607`).
2. In the repository settings, add the variables `AWS_DEPLOY_ROLE_ARN` and
   `AWS_DIFF_ROLE_ARN` (the stack outputs), `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
   None are secret.
3. Create the environment `production` with required reviewers and a deployment
   branch rule limited to `main`. The branch rule is what keeps other branches
   from deploying: the role trusts the environment, not the branch.

The workflows deploy the CDK stacks only. The Worker is still deployed with
Wrangler.

### Deploying through the CDK bootstrap roles

`cdk bootstrap` created the CDK roles, bucket and repository in the account.
Deploys then assume those roles instead of using powerful credentials directly.

- Bootstrap needs administrator-level access because it creates IAM roles. It was
  run once from AWS CloudShell, signed in as an administrator, so no admin access
  keys were created or stored on a laptop.
- The everyday command-line user was **not** given administrator rights. It only
  needs permission to assume the CDK roles (`sts:AssumeRole` on
  `cdk-hnb659fds-*` roles in the account and region).
- By default CloudFormation runs deployments with `AdministratorAccess`. This is
  acceptable for a single small stack, but it can be narrowed with
  `cdk bootstrap --cloudformation-execution-policies` if wanted.

## Setup steps, in order

1. **AWS, once:** run `cdk bootstrap` for the account and region from an
   administrator identity (CloudShell works).
2. **AWS, once:** give the deploying user a policy that only allows
   `sts:AssumeRole` on the CDK roles.
3. **Cloudflare:** create the Access application for the hostname. Add an Allow
   policy for people and, as a **separate** policy, a **Service Auth** policy that
   includes a service token. A token in an Allow policy does not work. Name the
   token after its client, for example `agenthelper-<laptop>-cli`, and give it a
   finite duration. Note the application's AUD tag (on the application's Overview
   page, not the policy page) and the team domain.
4. **Deploy:**

   ```sh
   cd aws
   npm install
   cp deploy.local.example.json deploy.local.json   # team domain and AUD tag
   npx cdk deploy --all
   ```

   This deploys the `AgentHarness` stack, then the `HarnessProxy` stack. The
   settings can also be passed as `-c key=value`. The `FunctionUrl` output is the
   origin address.
5. **Deploy the Worker:** build the UI in `cloudflare/web` (`npm install && npm run build`), then from `cloudflare/worker` copy `wrangler.example.jsonc` to
   `wrangler.jsonc`, set the hostname and the function URL (`ORIGIN`), then run
   `npx wrangler deploy`. It attaches to the hostname as a custom domain, which creates the DNS record, so delete any
   existing record for that name first. The Access application must cover that
   hostname.
6. **Verify:**
   - Calling the function URL directly with no token returns `401`.
   - Calling the public hostname with no token returns an Access login or `403`.
   - Calling the public hostname with a valid service token streams a reply. The
     repository's `clients/invoke_proxy.py` does this (see `clients/README.md`).
   - `uv run clients/mcp_proxy.py --list` shows the `ask_agent` tool, and
     `uv run clients/mcp_proxy.py "Hello"` gets a reply over MCP.

If a step fails, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md). It lists each
error seen during this setup, with its cause.

## What changed while getting it to work

The first design used a Cloudflare Origin Rule to rewrite the Host header. That
needs the Enterprise plan, so a Worker replaced it. Two bugs then showed up in
the Lambda: a service token's JWT has an empty `sub` that was read as "not
logged in", and the role was missing the `InvokeAgentRuntime` permission. Both
are fixed and documented in the troubleshooting guide.

## What is secret and what is not

| Item | Treat as |
|---|---|
| Access service token **client secret** | Secret. Keep in a password manager. Never commit it. |
| AWS access keys of any user | Secret. Avoid creating them where possible. |
| Access AUD tag, team domain | Not secret, but pass them as `-c` context or CI variables rather than hard-coding. |
| Function URL | Public by design. Protected by the JWT check. |
| Account id, harness ARNs, your hostname | Low risk, but they describe your setup. They live in git-ignored files (`.env`, `aws/deploy.local.json`, `cloudflare/worker/wrangler.jsonc`), with `*.example` templates in the repository. |

## Updating

Run `npx cdk deploy` from `aws/`. CDK shows the IAM and resource
changes first. Read them before confirming, especially any change to the role's
permissions or to the JWT check in `aws/lambda/handler.ts`.

## Recommended next steps

These are not done yet.

- **Account hygiene:** enable MFA on every IAM user, remove users that are not
  used, and use `aws login` (or IAM Identity Center) so that command-line access
  uses short-lived credentials instead of long-lived access keys.
- **MCP for claude.ai and Claude Desktop:** their custom connectors need OAuth.
  Set Access up as the OAuth authorization server for `/api/mcp`, so a person
  signs in once and the connector gets a token, then check that the Lambda
  accepts the JWT that results.
- **Cloudflare as code:** manage the Access application with Terraform or the
  Cloudflare provider so it cannot drift.
