import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { agent } from "../../agent/agent";
import { AgentHarnessStack } from "../lib/agent-harness-stack";
import { HarnessProxyStack } from "../lib/proxy-stack";

const app = new App();

// Deployment values (Access settings, ARNs with the account id) come from -c flags or from the
// git-ignored aws/deploy.local.json, so they stay out of the repository. The agent itself is
// defined in agent/agent.ts.
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
      `Missing "${key}". Pass it with: cdk deploy -c ${key}=<value>, or set it in aws/deploy.local.json`,
    );
  }
  // A value copied unchanged from deploy.local.example.json would deploy a proxy that rejects everyone.
  if (/[<>]/.test(value)) {
    throw new Error(`"${key}" is still a placeholder (${value}). Set the real value in aws/deploy.local.json`);
  }
  return value;
}

/** Reserved concurrency for the proxy Lambda: a whole number, or "off" to not reserve any. */
function reservedConcurrency(): number | undefined {
  // An empty value (an unset CI variable) means the default.
  const value = setting("reservedConcurrency") || 10;
  if (value === "off") return undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('"reservedConcurrency" must be a whole number of 1 or more, or "off"');
  }
  return count;
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

// The agent is defined in the committed agent/agent.ts. A setting left in deploy.local.json
// from before would otherwise be silently ignored.
for (const key of ["harnessName", "modelId"]) {
  if (key in local) {
    throw new Error(`"${key}" is now set in agent/agent.ts. Remove it from aws/deploy.local.json`);
  }
}
// -c modelId=<id> tries another model for one deploy without editing agent.ts.
const modelOverride = app.node.tryGetContext("modelId");

const harness = new AgentHarnessStack(app, "AgentHarness", {
  env,
  agent: typeof modelOverride === "string" && modelOverride ? { ...agent, model: modelOverride } : agent,
  systemPrompt: readFileSync(path.join(__dirname, "..", "..", "agent", "system-prompt.md"), "utf8").trim(),
});

const proxy = new HarnessProxyStack(app, "HarnessProxy", {
  env,
  accessTeamDomain: required("accessTeamDomain"),
  accessAud: required("accessAud"),
  harnessArns: externalHarnessArns(),
  reservedConcurrency: reservedConcurrency(),
  managedHarness: { alias: optional("harnessAlias", "managed"), arnParameterName: harness.arnParameterName },
});
// Deploy the harness (and its SSM parameter) before the proxy that reads it.
proxy.addStackDependency(harness);
