import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as path from 'path';
import { Construct } from 'constructs';

export interface ReviewStackProps extends cdk.StackProps {
  readonly reportBucket: s3.IBucket;
  readonly projectName?: string;
}

/**
 * Human Review スタック
 *
 * Amazon A2I の Private Workforce と、HumanTaskUi / FlowDefinition を管理する。
 * AWS サンプル (sample-bda-multi-page-a2i) と同様、HumanTaskUi / FlowDefinition は
 * SageMaker API 経由で作成する（CFN 型は未サポートアカウントがあるため使用しない）。
 *
 * trigger-review / review-complete Lambda は PipelineStack 側で作成される。
 */
export class ReviewStack extends cdk.Stack {
  public readonly flowDefinitionArn: string;
  public readonly workteamArn: string;
  /** DescribeWorkteam / ラベリングポータル URL 構築用 */
  public readonly workteamName: string;

  constructor(scope: Construct, id: string, props: ReviewStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const workteamName = `${projectName}-quality-reviewers`;
    this.workteamName = workteamName;
    const humanTaskUiName = `${projectName}-review-ui`;
    const flowDefinitionName = `${projectName}-quality-review-flow`;

    // -------------------------------------------------------
    // Cognito User Pool (Private Workforce 認証基盤)
    // -------------------------------------------------------
    const workforceUserPool = new cognito.UserPool(this, 'WorkforceUserPool', {
      userPoolName: `${projectName}-a2i-workforce`,
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
      standardThreatProtectionMode:
        cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      // PoC: ロールバック時にスタック削除を可能にする
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = workforceUserPool.addClient('WorkforceClient', {
      userPoolClientName: `${projectName}-a2i-workforce-client`,
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: ['https://localhost/callback'],
      },
    });

    workforceUserPool.addDomain('WorkforceDomain', {
      cognitoDomain: {
        domainPrefix: `${projectName}-wf-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    new cognito.CfnUserPoolGroup(this, 'ReviewerGroup', {
      userPoolId: workforceUserPool.userPoolId,
      groupName: 'quality-reviewers',
      description: 'Quality reviewers for A2I workforce',
    });

    // -------------------------------------------------------
    // IAM Role for A2I Flow Definition
    // -------------------------------------------------------
    const a2iRole = new iam.Role(this, 'A2iFlowRole', {
      roleName: `${projectName}-a2i-flow-role`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      inlinePolicies: {
        a2iS3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: [
                props.reportBucket.arnForObjects('review/*'),
                props.reportBucket.arnForObjects('images/*'),
                props.reportBucket.arnForObjects('results/*'),
              ],
            }),
          ],
        }),
      },
    });

    // -------------------------------------------------------
    // Private Workteam (CfnWorkteam)
    // -------------------------------------------------------
    const workteam = new sagemaker.CfnWorkteam(this, 'QualityReviewWorkteam', {
      workteamName,
      description: 'Private workforce for quality review',
      memberDefinitions: [
        {
          cognitoMemberDefinition: {
            cognitoUserPool: workforceUserPool.userPoolId,
            cognitoClientId: userPoolClient.userPoolClientId,
            cognitoUserGroup: 'quality-reviewers',
          },
        },
      ],
    });

    this.workteamArn = cdk.Arn.format(
      {
        service: 'sagemaker',
        resource: 'workteam/private-crowd',
        resourceName: workteamName,
      },
      this,
    );

    // -------------------------------------------------------
    // Worker Task Template (HTML)
    // -------------------------------------------------------
    const taskTemplateContent = [
      '<script src="https://assets.crowd.aws/crowd-html-elements.js"></script>',
      '<crowd-form>',
      '  <div style="display:flex;gap:16px;min-height:80vh">',
      '    <div style="flex:1;border:1px solid #ddd;border-radius:4px;padding:12px;overflow:auto">',
      '      <h3>元画像</h3>',
      '      <img src="{{ task.input.originalImageUrl | grant_read_access }}" style="max-width:100%;height:auto" alt="元画像"/>',
      '    </div>',
      '    <div style="flex:1;border:1px solid #ddd;border-radius:4px;padding:12px;overflow:auto">',
      '      <h3>AI 抽出結果（編集可能）</h3>',
      '      <p><strong>信頼度スコア:</strong> {{ task.input.confidenceScore }}</p>',
      '      <p><strong>レポート ID:</strong> {{ task.input.reportId }}</p>',
      '      <p><strong>ページ / セクション:</strong> {{ task.input.pageSection }}</p>',
      '      <crowd-text-area name="extractedText" label="抽出テキスト" rows="10"',
      '        value="{{ task.input.extractedText }}"></crowd-text-area>',
      '      <crowd-text-area name="defectType" label="不具合分類" rows="2"',
      '        value="{{ task.input.defectType }}"></crowd-text-area>',
      '      <crowd-text-area name="correctedContent" label="修正内容（必要な場合）" rows="5"></crowd-text-area>',
      '    </div>',
      '  </div>',
      '  <div style="margin-top:16px">',
      '    <p><strong>判定:</strong></p>',
      '    <crowd-radio-group>',
      '      <crowd-radio-button name="decision" value="approve">承認</crowd-radio-button>',
      '      <crowd-radio-button name="decision" value="edit_approve">修正して承認</crowd-radio-button>',
      '      <crowd-radio-button name="decision" value="reject">差し戻し</crowd-radio-button>',
      '    </crowd-radio-group>',
      '  </div>',
      '</crowd-form>',
    ].join('\n');

    // -------------------------------------------------------
    // HumanTaskUi / FlowDefinition (SageMaker API via Custom Resource)
    // sample-bda-multi-page-a2i と同じパターン
    // -------------------------------------------------------
    const setupA2iLogGroup = new logs.LogGroup(this, 'SetupA2iLogGroup', {
      logGroupName: `/aws/lambda/${projectName}-setup-a2i`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const setupA2iFn = new lambda.Function(this, 'SetupA2iFn', {
      functionName: `${projectName}-setup-a2i`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/setup-a2i')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: setupA2iLogGroup,
    });

    setupA2iFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'sagemaker:CreateHumanTaskUi',
          'sagemaker:DescribeHumanTaskUi',
          'sagemaker:CreateFlowDefinition',
          'sagemaker:DescribeFlowDefinition',
        ],
        resources: ['*'],
      }),
    );
    setupA2iFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [a2iRole.roleArn],
      }),
    );

    const setupProvider = new cr.Provider(this, 'SetupA2iProvider', {
      onEventHandler: setupA2iFn,
    });

    const a2iSetup = new cdk.CustomResource(this, 'A2iSetup', {
      serviceToken: setupProvider.serviceToken,
      properties: {
        HumanTaskUiName: humanTaskUiName,
        FlowDefinitionName: flowDefinitionName,
        WorkteamArn: this.workteamArn,
        RoleArn: a2iRole.roleArn,
        S3OutputPath: `s3://${props.reportBucket.bucketName}/review/`,
        TaskTemplateContent: taskTemplateContent,
        TaskTitle: '品質レポート OCR 結果レビュー',
        TaskDescription:
          'AI が抽出した品質レポートの内容を確認し、必要に応じて修正してください。',
        TaskTimeLimitInSeconds: 3600,
        ConfigVersion: '3',
      },
    });
    a2iSetup.node.addDependency(workteam);

    this.flowDefinitionArn = a2iSetup.getAttString('FlowDefinitionArn');

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'FlowDefinitionArnOutput', {
      value: this.flowDefinitionArn,
      description: 'A2I Flow Definition ARN',
      exportName: `${projectName}-flow-definition-arn`,
    });

    new cdk.CfnOutput(this, 'WorkteamArnOutput', {
      value: this.workteamArn,
      description: 'SageMaker Workteam ARN',
      exportName: `${projectName}-workteam-arn`,
    });

    new cdk.CfnOutput(this, 'WorkforceUserPoolIdOutput', {
      value: workforceUserPool.userPoolId,
      description: 'Workforce Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'WorkteamNameOutput', {
      value: workteamName,
      description: 'SageMaker Private Workteam name (labeling portal)',
      exportName: `${projectName}-workteam-name`,
    });
  }
}
