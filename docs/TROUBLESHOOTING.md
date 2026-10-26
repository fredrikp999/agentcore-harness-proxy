# Troubleshooting and lessons learned

Problems hit while setting up the proxy (Cloudflare Access, a Worker and a
Lambda in front of an AgentCore harness), in the order a request meets them.
Use it when repeating this setup or debugging a similar one. It uses
placeholders for account ids, hostnames and tokens.

## How to debug a request that crosses several layers

A request here passes through five places: the client, Cloudflare Access, the
Worker, the Lambda and AgentCore. Each layer answers differently, so the
response tells you which one rejected it.

1. **Test from the outside in, one layer at a time.** Call the public hostname
   with no token, then with a token, then call the Lambda function URL directly.
   Each result narrows the problem to one layer.
2. **Read the log of the layer that failed**, not the one nearest to you. The
   Lambda log said what was wrong when the client only saw `502`.
3. **Make every failure path log something.** A silent `401` cost hours. Each
   rejection in the Lambda now writes a line saying why. Keep it that way when
   you change the handler.
4. **Do not trust the client's error body.** Cloudflare replaces some upstream
   `502` responses with its own `error code: 502` text, hiding the Lambda's JSON.
5. **Check what is actually deployed before debugging code.** See
   [Checking what is deployed](#checking-what-is-deployed).

## Symptoms, causes and fixes

### AWS and CDK

| Symptom | Cause | Fix |
|---|---|---|
| `cdk bootstrap` fails with `AccessDenied ... cloudformation:CreateChangeSet` | The everyday CLI user has no CloudFormation or IAM rights, which is correct. | Run bootstrap once from an administrator identity. AWS CloudShell works and needs no access keys. Then give the CLI user only `sts:AssumeRole` on the `cdk-hnb659fds-*` roles. |
| `aws login` is not a valid command, or `aws configure list-profiles` prints nothing | The AWS CLI is older than 2.32, or no credentials have been set up on this machine yet. | Upgrade the CLI, then run `aws login`, or use `aws configure` with IAM user access keys. See [AWS credentials](../README.md#aws-credentials) in the README. |
| `cdk deploy` finishes in about 3 seconds and changes nothing | The template and code were already deployed. | Nothing is wrong. Look for `Publishing Proxy/Code` and `deploying... [1/1]` when you expect a change. |
| Tested right after `cdk deploy` and saw old behaviour | CloudFormation had not finished the update, or the deploy output was not read. | Wait for the `HarnessProxy` success line and the Outputs block before testing. |
| `Failed to spawn: invoke_proxy.py` | The script path is relative to where `uv run` was started. | From the repository root run `uv run clients/invoke_proxy.py`. The scripts find the root `.env` from any folder. |
| README said the harness used Sonnet, but it used Nova Micro | The harness had been changed in the console after it was created, so the docs drifted. | Read the real configuration (`get_harness` in the `bedrock-agentcore-control` API) before describing or recreating a harness. This is a reason to define it in the `AgentHarness` stack. |
| Cannot find the Lambda log group | CDK named it itself, for example `<StackName>-ProxyLogs<hash>`, not `/aws/lambda/...`. | Open CloudWatch, then Log groups, and look for the stack name. The `/aws/bedrock-agentcore/runtimes/...` group belongs to the harness and is noisy (it restarts every few minutes). |

### Cloudflare dashboard

| Symptom | Cause | Fix |
|---|---|---|
| No usable "Origin Rule" for the Host header | **Host header rewrite is Enterprise-only.** The option is greyed out on Free and leads to an upgrade page. | Use a Worker that calls the function URL. `fetch` sets Host from the target URL. See `cloudflare/worker/`. |
| Opened Redirect Rules by mistake | Rules has several rule types. Redirect Rules send visitors elsewhere. | Not needed here. Do not create one. |
| Worker custom domain will not attach | A DNS record with the same name already exists. | Delete the old record first. The custom domain creates its own. |

### Cloudflare Access

| Symptom | Cause | Fix |
|---|---|---|
| Service token request returns the Access login page (HTML, or `302` to `<team>.cloudflareaccess.com`) | The policy that includes the token has action **Allow**. Service tokens only work with **Service Auth**. | Edit the policy and change its action to Service Auth. Keep the person's Allow policy as a separate policy. |
| Same symptom | Client ID or secret wrong. The ID ends in `.access`. The secret is shown only once. | Re-copy both, or refresh the token to get a new secret. |
| Where do I find the AUD tag? | It is on the application's Overview page, not on the policy page. The policy ID is a different value and a common mix-up. | The `kid` query parameter in the Access login redirect URL is also the application's AUD tag, useful as a cross-check. |

### Calling the proxy from a script

| Symptom | Cause | Fix |
|---|---|---|
| `error code: 1010`, HTTP 403 | Cloudflare's Browser Integrity Check blocks the default `Python-urllib` User-Agent. It is not an Access error. | Send a custom `User-Agent`, as `clients/invoke_proxy.py` does. |
| The script prints an HTML login page | The HTTP client followed Access's redirect. | Do not follow redirects, so the real status is visible. `clients/invoke_proxy.py` stops and explains. |
| `curl` output arrives all at once | Output buffering. | Use `curl -N`. |
| `mcp_proxy.py` fails with `JSONDecodeError: Expecting value` after `initialize` | The proxy answered `notifications/initialized` with `200 application/octet-stream` and an empty body instead of `202`. **With Lambda response streaming, the status and headers only go out with the first write**, and the handler wrote nothing. | The handler now writes an empty chunk before ending the 202, and `mcp_proxy.py` treats any empty body as no reply. Check with `curl -D -` that the notification gets `HTTP/2 202`. |
| Replies start with `<thinking>...</thinking>` | Nova models put their reasoning in these tags, especially when tools are available, and a system prompt telling them not to doesn't stop it. | The Lambda removes the blocks from the stream before sending it, for `/api/chat`, `/api/mcp` and the web UI. A block that never closes hides the rest of the reply. To see them, call the MCP tool with `include_trace` (`mcp_proxy.py --trace`). |
| `/api/mcp` returns `403` `browser origins are not allowed` | The request had an `Origin` header. Browsers send one; MCP clients don't. | Call it from an MCP client or a script, not from a web page. |
| An MCP client reports it can't connect, or asks to authenticate | Access redirected it to the login page: no service token headers, or the client can't send fixed headers (claude.ai and Claude Desktop connectors expect OAuth). | Add the token with `claude mcp add ... --header`. See [MCP](../aws/README.md#mcp). |

### Worker

| Symptom | Cause | Fix |
|---|---|---|
| Web UI shows `request failed (HTTP 500)` and the Harness list is empty; `wrangler tail` logs `ORIGIN is missing or not a URL` | `vars.ORIGIN` in `wrangler.jsonc` was still the `https://<function-url-host>` placeholder copied from `wrangler.example.jsonc`. An earlier deploy had passed the origin with `--var`, and a plain `wrangler deploy` replaced it with the placeholder. The Lambda log shows no request at all. | Set `vars.ORIGIN` to the stack's `FunctionUrl` output without the trailing slash and run `npx wrangler deploy`. |
| `/` returns `{"error":"not found"}` (JSON) instead of the web UI | The deployed Worker predates the UI and forwards every path to the Lambda, which only knows the `/api/*` routes. A JSON 404 comes from the Lambda; the current Worker's own 404 is plain text. | Build the UI (`npm run build` in `cloudflare/web/`) and run `npx wrangler deploy` in `cloudflare/worker`. |
| `error code: 1101`, HTTP 500 | The Worker threw an unhandled exception. Here `ORIGIN` was not set, so `new URL(undefined)` threw. | Set `vars.ORIGIN` in `wrangler.jsonc` (or pass `--var ORIGIN:...`). A `--var` given on one deploy is dropped by the next plain `wrangler deploy`, so keep it in the file. The Worker now answers `500 proxy misconfigured` and logs the reason. |
| Worker forwards to another host | `new URL("//host/x", base)` treats the path as protocol-relative. | The Worker builds the target by concatenating onto the origin and rejects any result that leaves it. Keep that check. |
| Worker reachable on a `workers.dev` address that Access does not protect | Wrangler enables `workers.dev` by default. | `workers_dev: false` and `preview_urls: false` in `wrangler.jsonc`. |
| Need to see what the Worker received | `console.log` output is not stored. | `npx wrangler tail` while sending a request. |

### Lambda

| Symptom | Cause | Fix |
|---|---|---|
| `401 unauthorized` with a valid token, and **no log line** | The JWT verified fine, but the handler returned an empty identity. **A service token's JWT has `sub: ""`**, and `??` does not skip an empty string, so the caller's `if (!user)` rejected it. | Return the first non-empty value of `email`, `common_name`, `sub`. Treat an identity as valid only if it is non-empty. |
| `401` with a log line `access jwt rejected ...` | The log gives the reason. `unexpected "aud" claim` means a wrong `accessAud`. `unexpected "iss" claim` means a wrong `accessTeamDomain` (no `https://`). | Redeploy with the right `-c` values. |
| `401` with `access jwt missing` | The `Cf-Access-Jwt-Assertion` header did not arrive. | Check the Access application covers the hostname. Check the Worker forwards headers. |
| Client sees `502` and `error code: 502`, Lambda log shows `AccessDeniedException ... is not authorized to perform: bedrock-agentcore:InvokeAgentRuntime on resource: ...harness/...` | **`InvokeHarness` is also authorized as `InvokeAgentRuntime` on the harness ARN.** The role had only `InvokeHarness`. | Grant both actions on the harness ARN. If a later error names another resource, add exactly that. |
| `cdk deploy` fails with `ReservedConcurrentExecutions ... decreases account's UnreservedConcurrentExecution below its minimum value of [10]` | The account's Lambda concurrency limit is 10 (the default on new accounts), and Lambda keeps 10 unreserved. The stack rolls back cleanly. | Request a higher "Concurrent executions" quota in Service Quotas, or set `reservedConcurrency` to `off` (`aws/deploy.local.json`, `-c`, or the `RESERVED_CONCURRENCY` GitHub variable). |
| Unsure if `runtimeUserId` is needed | The working script does not send it. Sending the service token's client id (it contains a dot) was an unneeded variable. | Not sent. Add it back only with a reason, and test it. |
| GitHub Actions: `Source Account ID is needed if the Role Name is provided and not the Role Arn` | The `AWS_DEPLOY_ROLE_ARN` or `AWS_DIFF_ROLE_ARN` variable holds the role name. | Set it to the full ARN, from the `GithubOidcDeploy` stack outputs. |
| GitHub Actions: `Not authorized to perform sts:AssumeRoleWithWebIdentity`, though the role's trust policy names the right repository | Newer GitHub accounts put numeric ids in the token subject, e.g. `repo:<owner>@<id>/<repo>@<id>:pull_request`, so `repo:<owner>/<repo>:...` never matches. | Print the token's `sub` (decode the token from `ACTIONS_ID_TOKEN_REQUEST_URL` in a step), then redeploy the stack with `GitHubSubjectRepo=<owner>@<id>/<repo>@<id>`. "Re-run jobs" replays the old commit, so check the run for the newest one. |

## Checking what is deployed

Do these before suspecting the code:

- **Stack status and time:**
  `aws cloudformation describe-stacks --stack-name HarnessProxy --region <region> --query 'Stacks[0].[StackStatus,LastUpdatedTime]'`
- **Values the stack was built with.** After `cdk synth` or `cdk deploy`,
  `aws/cdk.out/HarnessProxy.template.json` holds the Lambda's environment
  variables, such as the AUD and team domain it will run with.
- **Whether a bundle has your latest code.** Search the newest folder in
  `aws/cdk.out/` for a string you just added to a log message.
- **Lambda Last modified** in the Lambda console, against the time of your deploy.

## Things that worked well

- Bootstrapping from CloudShell with an administrator, then giving the daily CLI
  user only `sts:AssumeRole` on the CDK roles.
- Two independent checks: Cloudflare Access in front and JWT verification in the
  Lambda. When the Access setup was wrong, nothing unsafe was exposed.
- A Worker instead of paying for a plan upgrade, kept free of auth logic.
- Testing each layer with `curl` before writing client code.
- Logging the reason for every rejection.

## Checklist for the next similar setup

1. Bootstrap CDK as an administrator, once per account and region.
2. Create the Access application, a person policy (Allow) and a service-token
   policy (**Service Auth**). Note the AUD tag and team domain.
3. Deploy the stack with the AUD, team domain and harness ARNs from the git-ignored `aws/deploy.local.json` (or as `-c` context).
4. Grant the Lambda role `InvokeHarness` **and** `InvokeAgentRuntime` on the
   harness.
5. Deploy the Worker with `vars.ORIGIN` set in `wrangler.jsonc`, with `workers_dev` off.
6. Test: function URL without a token (`401`), hostname without a token (login
   or `403`), hostname with a token (a streamed reply).
7. Check logs at each layer before changing code.
