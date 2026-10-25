import * as path from "node:path";
import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface HarnessProxyStackProps extends StackProps {
  /** Cloudflare Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  accessTeamDomain: string;
  /** Application Audience (AUD) tag of the Cloudflare Access application. */
  accessAud: string;
  /** Harnesses callers may select by name; the first one is the default. */
  harnessArns: Record<string, string>;
}

export class HarnessProxyStack extends Stack {
  constructor(scope: Construct, id: string, props: HarnessProxyStackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, "Proxy", {
      entry: path.join(__dirname, "..", "lambda", "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(150),
      logGroup: new logs.LogGroup(this, "ProxyLogs", { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        ACCESS_TEAM_DOMAIN: props.accessTeamDomain,
        ACCESS_AUD: props.accessAud,
        HARNESS_ARNS: JSON.stringify(props.harnessArns),
      },
      // Bundle the AWS SDK so the InvokeHarness API doesn't depend on the runtime's older copy.
      bundling: { externalModules: [], minify: true, sourceMap: true },
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        // InvokeHarness is also authorized as InvokeAgentRuntime on the harness ARN.
        actions: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"],
        resources: Object.values(props.harnessArns),
      }),
    );

    // Public URL: the handler rejects any request without a valid Cloudflare Access JWT.
    const url = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    new CfnOutput(this, "FunctionUrl", { value: url.url });
  }
}
