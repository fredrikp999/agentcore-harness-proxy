import type { AgentConfig } from "../aws/lib/agent-harness-stack";

// What the agent is. The system prompt is next to this file in system-prompt.md.
// The AgentHarness stack turns this into the harness plus the IAM each enabled tool needs, so a
// tool is turned on here and nowhere else. No secrets or account-specific values belong here:
// this file is committed.
export const agent: AgentConfig = {
  // Part of the harness ARN. Changing it replaces the harness (see README.md).
  name: "agent_harness",
  // A Bedrock inference profile id. List them with:
  //   aws bedrock list-inference-profiles --region eu-west-1 --query "inferenceProfileSummaries[].inferenceProfileId"
  model: "eu.amazon.nova-micro-v1:0",

  tools: {
    // Python in an AWS-managed sandbox, for calculations, data analysis and generated files.
    codeInterpreter: true,
    // The AWS-managed headless browser, for reading and using web pages.
    browser: false,
    // Remote MCP servers without authentication. The model sees their tools as @<name>/<tool>.
    mcpServers: [
      // AWS documentation search and regional availability (run by AWS, read-only, 5 tools).
      { name: "aws_docs", url: "https://knowledge-mcp.global.api.aws" },
      // Questions about public GitHub repositories (run by Cognition, read-only, 3 tools).
      { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" },
    ],
  },
  // Which tools the model may call. "*" includes the built-in shell and file_operations tools,
  // which run inside the session's microVM.
  allowedTools: ["*"],

  limits: {
    maxIterations: 75,
    timeoutSeconds: 3_600,
    // Older messages are dropped once a session holds more than this many.
    contextMessages: 150,
    // The session, and what the agent remembers of it, ends after this long idle.
    idleSessionSeconds: 900,
    maxSessionSeconds: 28_800,
  },
};
