import { CfnOutput, Stack, StackProps, aws_bedrockagentcore as agentcore } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

export interface AgentHarnessStackProps extends StackProps {
  /** Name of the harness. It must be unique in the account and region. */
  harnessName: string;
  /** Bedrock model or inference profile id, e.g. "eu.amazon.nova-micro-v1:0". */
  modelId: string;
  /** The system prompt text. */
  systemPrompt: string;
}

/**
 * An AgentCore harness with the AWS-managed Code Interpreter as its only added tool, no memory and
 * a public network, plus its execution role.
 * The harness ARN is published in an SSM parameter so other stacks can read it without a
 * CloudFormation export, which would block replacing the harness while another stack uses it.
 */
export class AgentHarnessStack extends Stack {
  /** Name of the SSM parameter that holds the harness ARN. */
  readonly arnParameterName: string;

  constructor(scope: Construct, id: string, props: AgentHarnessStackProps) {
    super(scope, id, props);

    const { account, region } = this;
    // The harness's runtime is named after the harness; the role is scoped to that name.
    const runtime = `harness_${props.harnessName}`;
    // "eu.amazon.nova-micro-v1:0" is an inference profile over the foundation model below.
    const foundationModel = props.modelId.replace(/^(eu|us|apac|jp|au|global)\./, "");

    const role = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
    });

    // Based on the policy the AgentCore console generates for a harness, without the parts for
    // features this harness does not use (browser, EFS, S3 files, memory, bedrock-mantle). If the runtime fails to start, compare with that console policy first.
    const logGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes`;
    const statements = [
      new iam.PolicyStatement({
        sid: "BedrockModelInvocation",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
          `arn:aws:bedrock:${region}:${account}:inference-profile/${props.modelId}`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "EcrManagedImagePull",
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
        resources: [`arn:aws:ecr:${region}:*:repository/harness-*`],
      }),
      new iam.PolicyStatement({
        sid: "EcrTokens",
        actions: ["ecr:GetAuthorizationToken", "ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
        resources: ["*"],
      }),
      new iam.PolicyStatement({
        sid: "XRayTracing",
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        resources: ["*"],
      }),
      new iam.PolicyStatement({
        sid: "CloudWatchLogsGroup",
        actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        resources: [`${logGroups}/*`],
      }),
      new iam.PolicyStatement({
        sid: "CloudWatchLogsDescribeGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
      }),
      new iam.PolicyStatement({
        sid: "CloudWatchLogsStream",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`${logGroups}/*:log-stream:*`],
      }),
      new iam.PolicyStatement({
        sid: "CloudWatchLogsPutResourcePolicy",
        actions: ["logs:PutResourcePolicy"],
        resources: [`${logGroups}/${runtime}-*`],
      }),
      new iam.PolicyStatement({
        sid: "CloudWatchMetricsPublish",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
      }),
      new iam.PolicyStatement({
        sid: "AgentCoreWorkloadIdentity",
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/${runtime}-*`,
        ],
      }),
      // The AWS-managed code interpreter (aws.codeinterpreter.v1), which the code interpreter tool
      // uses when no codeInterpreterArn is given.
      new iam.PolicyStatement({
        sid: "AgentCoreCodeInterpreterDefault",
        actions: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:StopCodeInterpreterSession",
          "bedrock-agentcore:GetCodeInterpreterSession",
          "bedrock-agentcore:ListCodeInterpreterSessions",
          "bedrock-agentcore:InvokeCodeInterpreter",
        ],
        resources: [`arn:aws:bedrock-agentcore:${region}:aws:code-interpreter/*`],
      }),
    ];
    statements.forEach((statement) => role.addToPolicy(statement));

    const harness = new agentcore.CfnHarness(this, "Harness", {
      harnessName: props.harnessName,
      executionRoleArn: role.roleArn,
      model: { bedrockModelConfig: { modelId: props.modelId, apiFormat: "converse_stream" } },
      systemPrompt: [{ text: props.systemPrompt }],
      // Runs Python in a sandbox for calculations, data analysis and generated files.
      tools: [{ type: "agentcore_code_interpreter", config: { agentCoreCodeInterpreter: {} } }],
      allowedTools: ["*"],
      truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 150 } } },
      memory: { disabled: {} },
      environment: {
        agentCoreRuntimeEnvironment: {
          lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28_800 },
          networkConfiguration: { networkMode: "PUBLIC" },
        },
      },
      maxIterations: 75,
      timeoutSeconds: 3_600,
    });
    // Wait for the role and its policy, not just the role itself.
    harness.node.addDependency(role);

    const harnessArn = harness.harnessRef.harnessArn;
    this.arnParameterName = `/agent-harness/${props.harnessName}/arn`;
    new ssm.StringParameter(this, "ArnParameter", {
      parameterName: this.arnParameterName,
      stringValue: harnessArn,
      description: "ARN of the AgentCore harness managed by this stack",
    });

    new CfnOutput(this, "HarnessArn", { value: harnessArn });
  }
}
