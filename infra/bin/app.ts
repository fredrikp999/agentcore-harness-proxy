import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { HarnessProxyStack } from "../lib/harness-stack";

const app = new App();

// Deployment values (Access settings, harness ARNs with the account id) come from -c flags or
// from the git-ignored infra/deploy.local.json, so they stay out of the repository.
const localFile = path.join(__dirname, "..", "deploy.local.json");
const local: Record<string, unknown> = existsSync(localFile)
  ? JSON.parse(readFileSync(localFile, "utf8"))
  : {};

function setting(key: string): unknown {
  return app.node.tryGetContext(key) ?? local[key];
}

function required(key: string): string {
  const value = setting(key);
  if (typeof value !== "string" || !value) {
    throw new Error(
      `Missing "${key}". Pass it with: cdk deploy -c ${key}=<value>, or set it in infra/deploy.local.json`,
    );
  }
  return value;
}

function harnessArns(): Record<string, string> {
  let value = setting("harnessArns");
  if (typeof value === "string") value = JSON.parse(value);
  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  if (entries.length === 0 || entries.some(([, arn]) => typeof arn !== "string" || !arn)) {
    throw new Error(
      'Missing "harnessArns": an object of name -> harness ARN, in infra/deploy.local.json or -c harnessArns=\'{"name":"arn"}\'. The first name is the default.',
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

new HarnessProxyStack(app, "HarnessProxy", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "eu-west-1" },
  accessTeamDomain: required("accessTeamDomain"),
  accessAud: required("accessAud"),
  harnessArns: harnessArns(),
});
