# The agent

What the agent is. Change these files to change how it behaves; the `AgentHarness`
stack in [`../aws`](../aws/README.md#the-harness-stack) turns them into an Amazon
Bedrock AgentCore harness.

| File | Holds |
|---|---|
| [`agent.ts`](agent.ts) | Name, model, tools, `allowedTools` and limits. Type-checked against `AgentConfig` in `aws/lib/agent-harness-stack.ts`. |
| [`system-prompt.md`](system-prompt.md) | The system prompt. |

Both files are committed, so every change to the agent is in git history. Secrets
and account-specific values never go here.

## Current setup

The harness runs in eu-west-1, has no memory, and its runtime uses a `PUBLIC`
network. Its tools:

- **Code Interpreter** (AWS-managed): runs Python in a sandbox, so the agent can
  calculate, analyse data and produce files instead of guessing.
- **`aws_docs`**, the [AWS Knowledge MCP server](https://knowledge-mcp.global.api.aws):
  searches and reads the AWS documentation and checks regional availability.
- **`deepwiki`**, the [DeepWiki MCP server](https://mcp.deepwiki.com/mcp):
  answers questions about public GitHub repositories.
- The built-in `shell` and `file_operations` tools, which run inside the
  session's microVM and are allowed by `allowedTools: ["*"]`.

Both MCP servers are public, read-only and need no key. Questions that use them
are sent to AWS and to Cognition (DeepWiki) respectively.

## Making changes

Edit the file, then from `aws/` review and deploy:

```sh
npx cdk diff AgentHarness
npx cdk deploy AgentHarness
```

- **Change the model:** set `model` to a Bedrock inference profile id. List them
  with `aws bedrock list-inference-profiles --region eu-west-1 --query "inferenceProfileSummaries[].inferenceProfileId"`.
  The execution role's Bedrock permission follows the model id. To try a model
  for one deploy without editing the file, pass `-c modelId=<id>`. A Claude model
  may first need enabling in the Bedrock console (model catalog).
- **Add a tool:** set `codeInterpreter` or `browser` to `true`, or add
  `{ name, url }` to `mcpServers`. The stack adds the matching IAM statement.
  Only MCP servers without authentication are supported so far; one that needs a
  key should get it from an AgentCore Identity credential provider, added to the
  stack together with the IAM to read it.
- **Rename the agent:** `name` cannot change in place. CloudFormation creates a
  new harness with a new ARN and deletes the old one, which ends its sessions.
  Redeploy `HarnessProxy` afterwards so it picks up the new ARN.
