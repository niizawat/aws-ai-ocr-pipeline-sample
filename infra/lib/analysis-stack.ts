import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { s3vectors } from '@cdklabs/generative-ai-cdk-constructs';

import type { Construct } from 'constructs';

export interface AnalysisStackProps extends cdk.StackProps {
  readonly flowDefinitionArn?: string;
  /** A2I Private Workforce の Workteam 名（ラベリングポータル URL 用） */
  readonly workteamName?: string;
  readonly vpc: ec2.IVpc;
  readonly ecsFargateSg: ec2.ISecurityGroup;
  readonly albSg: ec2.ISecurityGroup;
  readonly reportBucket: s3.IBucket;
  readonly reportTable: dynamodb.ITable;
  readonly webRepository: ecr.IRepository;
  readonly webImageTag: string;
  readonly projectName?: string;
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
}

/**
 * 分析・可視化スタック
 * S3 Vectors、Next.js(Material UI) ECS Fargate サービス、API Gateway HTTP API
 * （VPC Link + Cloud Map private integration）、Cognito 認証を管理する。
 * 認証は Next.js(Auth.js) 層で行うため、API Gateway の JWT Authorizer は付与しない。
 */
export class AnalysisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnalysisStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const bedrockEmbedModelId = 'amazon.titan-embed-text-v2:0';
    const bedrockChatModelId = 'us.anthropic.claude-sonnet-4-6';
    const bedrockChatFoundationModelId = 'anthropic.claude-sonnet-4-6';
    // us.anthropic.claude-sonnet-4-6 がルーティングするリージョン
    const bedrockChatRegions = ['us-east-1', 'us-east-2', 'us-west-2'] as const;
    const vectorBucketName = `${projectName}-vectors-${cdk.Aws.REGION}`;
    const vectorIndexName = 'report-embeddings';

    // -------------------------------------------------------
    // Route53 Hosted Zone (既存ゾーンを参照)
    // -------------------------------------------------------
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'HostedZone',
      {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      },
    );

    // -------------------------------------------------------
    // ACM Certificate (DNS 検証)
    // -------------------------------------------------------
    const certificate = new acm.Certificate(this, 'CloudFrontCertificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // -------------------------------------------------------
    // S3 Vectors (L2 Construct)
    // -------------------------------------------------------
    const vectorBucket = new s3vectors.VectorBucket(this, 'VectorBucket', {
      vectorBucketName: vectorBucketName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new s3vectors.VectorIndex(this, 'VectorIndex', {
      vectorBucket,
      vectorIndexName: vectorIndexName,
      dimension: 1024,
      distanceMetric: s3vectors.VectorIndexDistanceMetric.COSINE,
    });

    // -------------------------------------------------------
    // Cognito User Pool (Web アプリ認証用 / 既存プールを維持するため論理 ID は据え置き)
    // -------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'StreamlitUserPool', {
      userPoolName: `${projectName}-streamlit-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('StreamlitDomain', {
      cognitoDomain: {
        domainPrefix: `${projectName}-app-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // Better Auth の Cognito Provider 用クライアント。
    // Confidential クライアント（Client Secret あり）+ Authorization Code Grant。
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: `${projectName}-web-client`,
      generateSecret: true,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `https://${props.domainName}/api/auth/callback/cognito`,
        ],
        logoutUrls: [`https://${props.domainName}/`],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    // Better Auth のセッション暗号化に使う BETTER_AUTH_SECRET（自動生成）
    const authSecret = new secretsmanager.Secret(this, 'WebAuthSecret', {
      secretName: `${projectName}-web-auth-secret`,
      description: 'Better Auth BETTER_AUTH_SECRET for the Next.js web app',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'password',
        passwordLength: 44,
        excludePunctuation: true,
      },
    });

    // Cognito Client Secret を Secrets Manager に保存
    const cognitoClientSecret = new secretsmanager.Secret(
      this,
      'CognitoClientSecret',
      {
        secretName: `${projectName}-cognito-client-secret`,
        description: 'Cognito App Client Secret for Better Auth',
        secretStringValue: userPoolClient.userPoolClientSecret,
      },
    );

    // -------------------------------------------------------
    // ECS Cluster (Fargate)
    // -------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'WebCluster', {
      clusterName: `${projectName}-web`,
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // -------------------------------------------------------
    // ECS Task Definition
    // -------------------------------------------------------
    const taskRole = new iam.Role(this, 'WebTaskRole', {
      roleName: `${projectName}-web-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // S3 アクセス
    props.reportBucket.grantReadWrite(taskRole);

    // DynamoDB アクセス
    props.reportTable.grantReadWriteData(taskRole);

    // S3 Vectors アクセス (L2 grant helpers)
    vectorBucket.grantRead(taskRole);
    vectorBucket.grantWrite(taskRole);

    // Bedrock: Titan Embeddings + Claude Sonnet 4.6 (inference profile)
    // inference profile 利用時は profile ARN と配下 foundation model 両方への InvokeModel が必要
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${bedrockEmbedModelId}`,
          ...bedrockChatRegions.map(
            (region) =>
              `arn:aws:bedrock:${region}::foundation-model/${bedrockChatFoundationModelId}`,
          ),
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${bedrockChatModelId}`,
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.${bedrockChatFoundationModelId}`,
        ],
      }),
    );

    // A2I 読み取りアクセス (レビュー管理画面用)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:ListHumanLoops'],
        resources: [
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:flow-definition/${projectName}-*`,
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:/human-loops`,
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:DescribeHumanLoop'],
        resources: [
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:human-loop/*`,
        ],
      }),
    );
    if (props.workteamName) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:DescribeWorkteam'],
          resources: [
            `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workteam/private-crowd/${props.workteamName}`,
          ],
        }),
      );
    }

    // Better Auth のシークレットを参照
    authSecret.grantRead(taskRole);
    cognitoClientSecret.grantRead(taskRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      family: `${projectName}-web`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new logs.LogGroup(this, 'WebLogGroup', {
      logGroupName: `/ecs/${projectName}/web`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('WebContainer', {
      containerName: 'web',
      image: ecs.ContainerImage.fromEcrRepository(
        props.webRepository,
        props.webImageTag,
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'web',
      }),
      environment: {
        S3_BUCKET: props.reportBucket.bucketName,
        DYNAMODB_TABLE: props.reportTable.tableName,
        VECTOR_BUCKET: vectorBucketName,
        VECTOR_INDEX: vectorIndexName,
        BEDROCK_EMBED_MODEL_ID: bedrockEmbedModelId,
        BEDROCK_CHAT_MODEL_ID: bedrockChatModelId,
        AWS_REGION: cdk.Aws.REGION,
        AWS_DEFAULT_REGION: cdk.Aws.REGION,
        // 認証（Better Auth / Cognito）
        AUTH_ENABLED: 'true',
        BETTER_AUTH_URL: `https://${props.domainName}`,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: `${projectName}-app-${cdk.Aws.ACCOUNT_ID}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
        COGNITO_REGION: cdk.Aws.REGION,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        ...(props.flowDefinitionArn
          ? { FLOW_DEFINITION_ARN: props.flowDefinitionArn }
          : {}),
        ...(props.workteamName ? { WORKTEAM_NAME: props.workteamName } : {}),
      },
      secrets: {
        BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret, 'password'),
        COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(cognitoClientSecret),
      },
      portMappings: [
        {
          containerPort: 3000,
          protocol: ecs.Protocol.TCP,
        },
      ],
      healthCheck: {
        command: [
          'CMD-SHELL',
          'wget -qO- "http://${HOSTNAME}:3000/api/health" || exit 1',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(40),
      },
      user: '1001:1001',
    });

    // -------------------------------------------------------
    // ECS Fargate Service
    // -------------------------------------------------------
    const service = new ecs.FargateService(this, 'WebService', {
      serviceName: `${projectName}-web`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [props.ecsFargateSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
    });

    // -------------------------------------------------------
    // Cloud Map (Private DNS) + ECS Service Discovery
    // -------------------------------------------------------
    // 論理 ID StreamlitNamespace を維持。
    // ロールバック後に CloudFormation 管理外へ残った quality-report.internal を参照（新規 CREATE は ConflictingDomainExists）
    const namespace = servicediscovery.PrivateDnsNamespace.fromPrivateDnsNamespaceAttributes(
      this,
      'StreamlitNamespace',
      {
        namespaceName: `${projectName}.internal`,
        namespaceId: 'ns-vytdqw3ltbzmmp2g',
        namespaceArn: `arn:aws:servicediscovery:${this.region}:${this.account}:namespace/ns-vytdqw3ltbzmmp2g`,
      },
    );

    const discoveryService = new servicediscovery.Service(this, 'WebDiscoveryService', {
      namespace,
      name: 'web',
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      dnsTtl: cdk.Duration.seconds(60),
      customHealthCheck: {
        failureThreshold: 1,
      },
    });
    service.associateCloudMapService({
      service: discoveryService,
      containerPort: 3000,
    });

    // -------------------------------------------------------
    // API Gateway HTTP API (private integration via Cloud Map)
    // -------------------------------------------------------
    const privateSubnetIds = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;
    const vpcLink = new apigwv2.CfnVpcLink(this, 'WebVpcLink', {
      name: `${projectName}-web-vpc-link`,
      subnetIds: privateSubnetIds,
      securityGroupIds: [props.albSg.securityGroupId],
    });

    // VPC Link SG → Next.js :3000（ingress は AnalysisStack、egress は NetworkStack の albSg で定義）
    props.ecsFargateSg.addIngressRule(
      props.albSg,
      ec2.Port.tcp(3000),
      'Next.js traffic from API Gateway VPC Link',
    );

    const httpApi = new apigwv2.CfnApi(this, 'WebHttpApi', {
      name: `${projectName}-web-api`,
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: [`https://${props.domainName}`],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Amz-Date', 'X-Api-Key'],
        allowCredentials: true,
        maxAge: 600,
      },
    });

    // 認証は Next.js(Auth.js) 層で実施するため、API Gateway 側は JWT Authorizer を付けない。
    const integration = new apigwv2.CfnIntegration(this, 'WebPrivateIntegration', {
      apiId: httpApi.ref,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'ANY',
      connectionType: 'VPC_LINK',
      connectionId: vpcLink.ref,
      payloadFormatVersion: '1.0',
      integrationUri: discoveryService.serviceArn,
    });

    const rootRoute = new apigwv2.CfnRoute(this, 'WebRootRoute', {
      apiId: httpApi.ref,
      routeKey: 'ANY /',
      target: `integrations/${integration.ref}`,
      authorizationType: 'NONE',
    });
    rootRoute.addDependency(integration);

    const proxyRoute = new apigwv2.CfnRoute(this, 'WebProxyRoute', {
      apiId: httpApi.ref,
      routeKey: 'ANY /{proxy+}',
      target: `integrations/${integration.ref}`,
      authorizationType: 'NONE',
    });
    proxyRoute.addDependency(integration);

    new apigwv2.CfnStage(this, 'WebApiDefaultStage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
    });

    // -------------------------------------------------------
    // CloudFront（API Gateway を Origin として公開）
    // -------------------------------------------------------
    const apiOriginDomain = `${httpApi.ref}.execute-api.${cdk.Aws.REGION}.${cdk.Aws.URL_SUFFIX}`;

    const webAcl = new wafv2.CfnWebACL(this, 'CloudFrontWebAcl', {
      name: `${projectName}-cloudfront-web-acl`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${projectName}-cloudfront-web-acl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // Better Auth の暗号化 Cookie と移行期の旧 Cookie 合算で
              // Cookie ヘッダー上限を超えるため、該当ルールのみ Count に緩和する。
              ruleActionOverrides: [
                {
                  name: 'SizeRestrictions_Cookie_HEADER',
                  actionToUse: { count: {} },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `${projectName} web (Next.js) distribution`,
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiOriginDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // API Gateway は execute-api ドメインの Host を要求するため Host は転送しない
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: [props.domainName],
      certificate,
      webAclId: webAcl.attrArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: false,
    });

    new route53.ARecord(this, 'AlbAliasRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${props.domainName}`,
      description: 'Web application URL',
      exportName: `${projectName}-web-app-url`,
    });

    new cdk.CfnOutput(this, 'HttpApiId', {
      value: httpApi.ref,
      description: 'HTTP API ID',
      exportName: `${projectName}-web-http-api-id`,
    });

    new cdk.CfnOutput(this, 'HttpApiEndpoint', {
      value: `https://${httpApi.ref}.execute-api.${cdk.Aws.REGION}.amazonaws.com`,
      description: 'HTTP API endpoint',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.domainName,
      description: 'CloudFront domain name',
    });
    new cdk.CfnOutput(this, 'CloudFrontWebAclArn', {
      value: webAcl.attrArn,
      description: 'WAF Web ACL ARN attached to CloudFront',
    });

    new cdk.CfnOutput(this, 'CloudMapServiceArn', {
      value: discoveryService.serviceArn,
      description: 'Cloud Map service ARN for private integration',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${projectName}-web-user-pool-id`,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: `https://${userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
      description: 'Cognito Hosted UI domain',
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: vectorBucketName,
      description: 'S3 Vectors bucket name',
    });

    new cdk.CfnOutput(this, 'VectorIndexName', {
      value: vectorIndexName,
      description: 'S3 Vectors index name',
    });
  }
}
