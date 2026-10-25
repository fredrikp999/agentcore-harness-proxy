import { CfnOutput, Stack, StackProps, aws_bedrockagentcore as agentcore } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/** The agent's definition, kept in infra/harness/agent.ts. */
export interface AgentConfig {
  /** Name of the harness. It must be unique in the account and region. */
  name: string;
  /** Bedrock inference profile id, e.g. "eu.amazon.nova-micro-v1:0". */
  model: string;
  tools: {
    /** The AWS-managed Code Interpreter. */
    codeInterpreter: boolean;
    /** The AWS-managed Browser. */
    browser: boolean;
    /** Remote MCP servers that need no authentication. */
    mcpServers: { name: string; url: string }[];
  };
  /** Tool patterns the model may call, e.g. "*", "@builtin", "@docs/search". */
  allowedTools: string[];
  limits: {
    maxIterations: number;
    timeoutSeconds: number;
    contextMessages: number;
    idleSessionSeconds: number;
    maxSessionSeconds: number;
  };
}

export interface AgentHarnessStackProps extends StackProps {
  agent: AgentConfig;
  /** The system prompt text. */
  systemPrompt: string;
}

/**
 * An AgentCore harness built from an AgentConfig, with no memory and a public network, plus its
 * execution role. Each enabled tool adds its tool entry and the IAM it needs.
 * The harness ARN is published in an SSM parameter so other stacks can read it without a
 * CloudFormation export, which would block replacing the harness while another stack uses it.
 */
export class AgentHarnessStack extends Stack {
  /** Name of the SSM parameter that holds the harness ARN. */
  readonly arnParameterName: string;

  constructor(scope: Construct, id: string, props: AgentHarnessStackProps) {
    super(scope, id, props);

    const { agent } = props;
    const { account, region } = this;
    // The harness's runtime is named after the harness; the role is scoped to that name.
    const runtime = `harness_${agent.name}`;
    // "eu.amazon.nova-micro-v1:0" is an inference profile over the foundation model below.
    const foundationModel = agent.model.replace(/^(eu|us|apac|jp|au|global)\./, "");

    const role = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${region}:${account}:*` },
        },
      }),
    });

    // Based on the policy the AgentCore console generates for a harness, without the parts for
    // features this harness does not use (EFS, S3 files, memory, bedrock-mantle). Tool permissions
    // are added below, only for the tools that are enabled. If the runtime fails to start, compare with that console policy first.
    const logGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes`;
    const statements = [
      new iam.PolicyStatement({
        sid: "BedrockModelInvocation",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${foundationModel}`,
          `arn:aws:bedrock:${region}:${account}:inference-profile/${agent.model}`,
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
    ];

    const tools: agentcore.CfnHarness.HarnessToolProperty[] = [];
    if (agent.tools.codeInterpreter) {
      tools.push({ type: "agentcore_code_interpreter", config: { agentCoreCodeInterpreter: {} } });
      // The AWS-managed code interpreter, used when the tool names no codeInterpreterArn.
      statements.push(
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
      );
    }
    if (agent.tools.browser) {
      tools.push({ type: "agentcore_browser", config: { agentCoreBrowser: {} } });
      // The AWS-managed browser, used when the tool names no browserArn.
      statements.push(
        new iam.PolicyStatement({
          sid: "AgentCoreBrowserDefault",
          actions: [
            "bedrock-agentcore:StartBrowserSession",
            "bedrock-agentcore:StopBrowserSession",
            "bedrock-agentcore:GetBrowserSession",
            "bedrock-agentcore:ListBrowserSessions",
            "bedrock-agentcore:UpdateBrowserStream",
            "bedrock-agentcore:ConnectBrowserAutomationStream",
            "bedrock-agentcore:ConnectBrowserLiveViewStream",
          ],
          resources: [`arn:aws:bedrock-agentcore:${region}:aws:browser/*`],
        }),
      );
    }
    // An unauthenticated MCP server needs no IAM; the session calls it over the public network.
    for (const server of agent.tools.mcpServers) {
      tools.push({ type: "remote_mcp", name: server.name, config: { remoteMcp: { url: server.url } } });
    }

    statements.forEach((statement) => role.addToPolicy(statement));

    const harness = new agentcore.CfnHarness(this, "Harness", {
      harnessName: agent.name,
      executionRoleArn: role.roleArn,
      model: { bedrockModelConfig: { modelId: agent.model, apiFormat: "converse_stream" } },
      systemPrompt: [{ text: props.systemPrompt }],
      tools,
      allowedTools: agent.allowedTools,
      truncation: {
        strategy: "sliding_window",
        config: { slidingWindow: { messagesCount: agent.limits.contextMessages } },
      },
      memory: { disabled: {} },
      environment: {
        agentCoreRuntimeEnvironment: {
          lifecycleConfiguration: {
            idleRuntimeSessionTimeout: agent.limits.idleSessionSeconds,
            maxLifetime: agent.limits.maxSessionSeconds,
          },
          networkConfiguration: { networkMode: "PUBLIC" },
        },
      },
      maxIterations: agent.limits.maxIterations,
      timeoutSeconds: agent.limits.timeoutSeconds,
    });
    // Wait for the role and its policy, not just the role itself.
    harness.node.addDependency(role);

    const harnessArn = harness.harnessRef.harnessArn;
    this.arnParameterName = `/agent-harness/${agent.name}/arn`;
    new ssm.StringParameter(this, "ArnParameter", {
      parameterName: this.arnParameterName,
      stringValue: harnessArn,
      description: "ARN of the AgentCore harness managed by this stack",
    });

    new CfnOutput(this, "HarnessArn", { value: harnessArn });
  }
}
