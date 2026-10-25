import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { agent } from "../harness/agent";
import { AgentHarnessStack } from "../lib/agent-harness-stack";
import { HarnessProxyStack } from "../lib/proxy-stack";

const app = new App();

// Deployment values (Access settings, ARNs with the account id) come from -c flags or from the
// git-ignored infra/deploy.local.json, so they stay out of the repository. The agent itself is
// defined in infra/harness/agent.ts.
const localFile = path.join(__dirname, "..", "deploy.local.json");
const local: Record<string, unknown> = existsSync(localFile)
  ? JSON.parse(readFileSync(localFile, "utf8"))
  : {};

function setting(key: string): unknown {
  return app.node.tryGetContext(key) ?? local[key];
}

function optional(key: string, fallback: string): string {
  const value = setting(key);
  return typeof value === "string" && value ? value : fallback;
}

function required(key: string): string {
  const value = setting(key);
  if (typeof value !== "string" || !value) {
    throw new Error(
      `Missing "${key}". Pass it with: cdk deploy -c ${key}=<value>, or set it in infra/deploy.local.json`,
    );
  }
  // A value copied unchanged from deploy.local.example.json would deploy a proxy that rejects everyone.
  if (/[<>]/.test(value)) {
    throw new Error(`"${key}" is still a placeholder (${value}). Set the real value in infra/deploy.local.json`);
  }
  return value;
}

/** Harnesses that already exist outside this app, as name -> ARN. Optional. */
function externalHarnessArns(): Record<string, string> {
  let value = setting("harnessArns");
  if (typeof value === "string") value = JSON.parse(value);
  if (value === undefined || value === null) return {};
  const entries = typeof value === "object" ? Object.entries(value) : [];
  if (entries.some(([, arn]) => typeof arn !== "string" || !arn)) {
    throw new Error('"harnessArns" must be an object of name -> harness ARN');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "eu-west-1" };

// The agent is defined in the committed infra/harness/agent.ts. A setting left in deploy.local.json
// from before would otherwise be silently ignored.
for (const key of ["harnessName", "modelId"]) {
  if (key in local) {
    throw new Error(`"${key}" is now set in infra/harness/agent.ts. Remove it from infra/deploy.local.json`);
  }
}
// -c modelId=<id> tries another model for one deploy without editing agent.ts.
const modelOverride = app.node.tryGetContext("modelId");

const harness = new AgentHarnessStack(app, "AgentHarness", {
  env,
  agent: typeof modelOverride === "string" && modelOverride ? { ...agent, model: modelOverride } : agent,
  systemPrompt: readFileSync(path.join(__dirname, "..", "harness", "system-prompt.md"), "utf8").trim(),
});

const proxy = new HarnessProxyStack(app, "HarnessProxy", {
  env,
  accessTeamDomain: required("accessTeamDomain"),
  accessAud: required("accessAud"),
  harnessArns: externalHarnessArns(),
  managedHarness: { alias: optional("harnessAlias", "managed"), arnParameterName: harness.arnParameterName },
});
// Deploy the harness (and its SSM parameter) before the proxy that reads it.
proxy.addStackDependency(harness);
