import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { s3vectors } from '@cdklabs/generative-ai-cdk-constructs';

import type { Construct } from 'constructs';

export interface AnalysisStackProps extends cdk.StackProps {
  readonly flowDefinitionArn?: string;
  /** A2I Private Workforce の Workteam 名（ラベリングポータル URL 用） */
  readonly workteamName?: string;
  readonly reportBucket: s3.IBucket;
  readonly reportTable: dynamodb.ITable;
  readonly webRepository: ecr.IRepository;
  readonly webImageTag: string;
  readonly projectName?: string;
  /** カスタムドメイン（省略時は CloudFront デフォルトドメインで公開） */
  readonly domainName?: string;
  /** Route53 Hosted Zone ID（domainName を指定した場合のみ必須） */
  readonly hostedZoneId?: string;
  /** Route53 Hosted Zone 名（domainName を指定した場合のみ必須） */
  readonly hostedZoneName?: string;
}

/**
 * 分析・可視化スタック
 *
 * Next.js を Lambda Web Adapter (LWA) でコンテナ Lambda 化し、
 * CloudFront → Lambda Function URL（OAC/SigV4）経由で公開する。
 * API Gateway の 29 秒タイムアウト制約を除去し、RAG 検索の SSE ストリーミングを実現する。
 *
 * 参考: https://zenn.dev/big_tanukiudon/articles/e6a04d6569b252
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

    const hasCustomDomain =
      !!props.domainName && !!props.hostedZoneId && !!props.hostedZoneName;

    // appBaseUrl はカスタムドメインがあればそれを使い、なければ CloudFront デフォルトドメインを使う。
    // distribution は後で定義されるため Lazy.string で synthesis 時に解決する。
    let distribution!: cloudfront.Distribution;
    const appBaseUrl = hasCustomDomain
      ? `https://${props.domainName!}`
      : cdk.Lazy.string({ produce: () => `https://${distribution.domainName}` });

    // -------------------------------------------------------
    // Route53 Hosted Zone + ACM Certificate（カスタムドメイン指定時のみ）
    // -------------------------------------------------------
    let hostedZone: route53.IHostedZone | undefined;
    let certificate: acm.ICertificate | undefined;

    if (hasCustomDomain) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        'HostedZone',
        {
          hostedZoneId: props.hostedZoneId!,
          zoneName: props.hostedZoneName!,
        },
      );
      certificate = new acm.Certificate(this, 'CloudFrontCertificate', {
        domainName: props.domainName!,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });
    }

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
          `${appBaseUrl}/api/auth/callback/cognito`,
        ],
        logoutUrls: [`${appBaseUrl}/`],
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
    // Lambda 実行ロール（旧 ECS taskRole の権限を移植）
    // -------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'WebTaskRole', {
      roleName: `${projectName}-web-task-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicExecutionRole',
      ),
    );

    // S3 アクセス
    props.reportBucket.grantReadWrite(lambdaRole);

    // DynamoDB アクセス
    props.reportTable.grantReadWriteData(lambdaRole);

    // S3 Vectors アクセス (L2 grant helpers)
    vectorBucket.grantRead(lambdaRole);
    vectorBucket.grantWrite(lambdaRole);

    // Bedrock: Titan Embeddings + Claude Sonnet 4.6 (inference profile)
    lambdaRole.addToPolicy(
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
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${bedrockChatModelId}`,
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/global.${bedrockChatFoundationModelId}`,
        ],
      }),
    );

    // A2I 読み取りアクセス (レビュー管理画面用)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:ListHumanLoops'],
        resources: [
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:flow-definition/${projectName}-*`,
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:/human-loops`,
        ],
      }),
    );
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:DescribeHumanLoop'],
        resources: [
          `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:human-loop/*`,
        ],
      }),
    );
    if (props.workteamName) {
      lambdaRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:DescribeWorkteam'],
          resources: [
            `arn:aws:sagemaker:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:workteam/private-crowd/${props.workteamName}`,
          ],
        }),
      );
    }

    // Secrets Manager からシークレットを読み取る権限
    authSecret.grantRead(lambdaRole);
    cognitoClientSecret.grantRead(lambdaRole);

    // -------------------------------------------------------
    // CloudWatch Logs グループ（Lambda）
    // -------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'WebLogGroup', {
      logGroupName: `/aws/lambda/${projectName}-web`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------
    // Next.js Lambda（LWA コンテナイメージ）
    // -------------------------------------------------------
    const webFn = new lambda.DockerImageFunction(this, 'WebFn', {
      functionName: `${projectName}-web`,
      code: lambda.DockerImageCode.fromEcr(props.webRepository, {
        tagOrDigest: props.webImageTag,
      }),
      architecture: lambda.Architecture.ARM_64,
      role: lambdaRole,
      memorySize: 1536,
      timeout: cdk.Duration.minutes(5),
      logGroup,
      environment: {
        S3_BUCKET: props.reportBucket.bucketName,
        DYNAMODB_TABLE: props.reportTable.tableName,
        VECTOR_BUCKET: vectorBucketName,
        VECTOR_INDEX: vectorIndexName,
        BEDROCK_EMBED_MODEL_ID: bedrockEmbedModelId,
        BEDROCK_CHAT_MODEL_ID: bedrockChatModelId,
        // 認証（Better Auth / Cognito）
        AUTH_ENABLED: 'true',
        BETTER_AUTH_URL: appBaseUrl,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: `${projectName}-app-${cdk.Aws.ACCOUNT_ID}.auth.${cdk.Aws.REGION}.amazoncognito.com`,
        COGNITO_REGION: cdk.Aws.REGION,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        // CloudFormation dynamic reference で Secrets Manager からシークレットを注入
        BETTER_AUTH_SECRET: authSecret.secretValueFromJson('password').unsafeUnwrap(),
        COGNITO_CLIENT_SECRET: cognitoClientSecret.secretValue.unsafeUnwrap(),
        ...(props.flowDefinitionArn
          ? { FLOW_DEFINITION_ARN: props.flowDefinitionArn }
          : {}),
        ...(props.workteamName ? { WORKTEAM_NAME: props.workteamName } : {}),
      },
    });

    // -------------------------------------------------------
    // Function URL（SSE ストリーミング: RESPONSE_STREAM）
    // AuthType は NONE: CloudFront WAF + 非公開 URL でアクセス制御
    // -------------------------------------------------------
    const fnUrl = webFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // -------------------------------------------------------
    // WAF Web ACL（CloudFront スコープ）
    // -------------------------------------------------------
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

    // -------------------------------------------------------
    // CloudFront（Lambda Function URL を Origin として公開）
    // -------------------------------------------------------
    distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      comment: `${projectName} web (Next.js LWA) distribution`,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      ...(hasCustomDomain && certificate
        ? {
            domainNames: [props.domainName!],
            certificate,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      webAclId: webAcl.attrArn,
      enableLogging: false,
    });

    if (hasCustomDomain && hostedZone) {
      new route53.ARecord(this, 'AlbAliasRecord', {
        zone: hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution),
        ),
      });
    }

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'AppUrl', {
      value: hasCustomDomain
        ? `https://${props.domainName}`
        : `https://${distribution.domainName}`,
      description: 'Web application URL',
      exportName: `${projectName}-web-app-url`,
    });

    new cdk.CfnOutput(this, 'WebFunctionArn', {
      value: webFn.functionArn,
      description: 'Next.js Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'WebFunctionUrl', {
      value: fnUrl.url,
      description: 'Lambda Function URL (direct, AWS IAM auth)',
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.domainName,
      description: 'CloudFront domain name',
    });

    new cdk.CfnOutput(this, 'CloudFrontWebAclArn', {
      value: webAcl.attrArn,
      description: 'WAF Web ACL ARN attached to CloudFront',
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
