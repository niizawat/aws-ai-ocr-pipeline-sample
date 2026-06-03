import * as cdk from 'aws-cdk-lib/core';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Construct } from 'constructs';

export interface OcrStackProps extends cdk.StackProps {
  /** 非同期入出力に使用する S3 バケット（reportBucket を共用） */
  readonly reportBucket: s3.IBucket;
  /** BYOC 推論イメージを格納する ECR リポジトリ */
  readonly ocrRepository: ecr.IRepository;
  /** 参照するイメージタグ（CodeBuild が push した固定タグ） */
  readonly ocrImageTag: string;
  readonly projectName?: string;
  /** SageMaker インスタンスタイプ（vLLM は CC>=8.0 が必要なため A10G/g5 を既定とする） */
  readonly instanceType?: string;
}

/** 非同期推論の出力・失敗オブジェクトの S3 プレフィックス */
export const OCR_ASYNC_OUTPUT_PREFIX = 'ocr-async-output/';
export const OCR_ASYNC_FAILURE_PREFIX = 'ocr-async-failure/';

/**
 * OCR 推論基盤スタック（SageMaker 非同期推論方式 / BYOC）
 *
 * aws-ocr-vision-lab と同じく、PyTorch DLC ベースの独自イメージ + model.tar.gz
 *（code/inference.py）方式で PP-StructureV3 を実行する。
 * 非同期推論エンドポイント + Application Auto Scaling により、
 * リクエストが無い間はインスタンス数 0（scale-to-0）へ縮退する。
 */
export class OcrStack extends cdk.Stack {
  public readonly endpointName: string;
  public readonly variantName = 'AllTraffic';

  constructor(scope: Construct, id: string, props: OcrStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const region = cdk.Stack.of(this).region;
    const instanceType = props.instanceType ?? 'ml.g5.xlarge';

    const imageUri = `${props.ocrRepository.repositoryUri}:${props.ocrImageTag}`;
    const asyncOutputPath = `s3://${props.reportBucket.bucketName}/${OCR_ASYNC_OUTPUT_PREFIX}`;
    const asyncFailurePath = `s3://${props.reportBucket.bucketName}/${OCR_ASYNC_FAILURE_PREFIX}`;
    const modelArtifactKey = 'model/model.tar.gz';
    const modelDataUrl = `s3://${props.reportBucket.bucketName}/${modelArtifactKey}`;

    // ========================================
    // SageMaker 実行ロール
    // ========================================
    const executionRole = new iam.Role(this, 'OcrSageMakerRole', {
      roleName: `${projectName}-ocr-sagemaker-role`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
    });
    // 非同期入力の読取り・出力/失敗の書込み
    props.reportBucket.grantReadWrite(executionRole);
    // BYOC イメージの取得
    props.ocrRepository.grantPull(executionRole);
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${region}:${this.account}:log-group:/aws/sagemaker/*`,
        ],
      }),
    );

    // ========================================
    // model.tar.gz（code/inference.py）を CustomResource で自動生成
    // ========================================
    const inferenceCodePath = path.join(
      __dirname,
      '..',
      'model',
      'code',
      'inference.py',
    );
    const inferenceCode = fs.readFileSync(inferenceCodePath, 'utf-8');
    const codeHash = crypto
      .createHash('md5')
      .update(inferenceCode)
      .digest('hex');

    const modelUploader = new lambda.Function(this, 'ModelUploaderFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'model-uploader')),
      timeout: cdk.Duration.minutes(1),
    });
    props.reportBucket.grantWrite(modelUploader);

    const modelUploaderProvider = new Provider(this, 'ModelUploaderProvider', {
      onEventHandler: modelUploader,
    });
    const modelUploaderResource = new cdk.CustomResource(this, 'ModelUploader', {
      serviceToken: modelUploaderProvider.serviceToken,
      properties: {
        BucketName: props.reportBucket.bucketName,
        InferenceCode: inferenceCode,
        OutputKey: modelArtifactKey,
        CodeHash: codeHash,
      },
    });

    // ========================================
    // モデル / エンドポイント構成 / エンドポイント
    // ========================================
    const model = new sagemaker.CfnModel(this, 'OcrModel', {
      modelName: `${projectName}-paddleocr-vl`,
      executionRoleArn: executionRole.roleArn,
      primaryContainer: {
        image: imageUri,
        modelDataUrl,
        environment: {
          SAGEMAKER_PROGRAM: 'inference.py',
          SAGEMAKER_SUBMIT_DIRECTORY: '/opt/ml/model/code',
          TS_DEFAULT_RESPONSE_TIMEOUT: '900',
          SAGEMAKER_MODEL_SERVER_TIMEOUT: '900',
          PADDLEOCR_HOME: '/opt/ml/code/.paddleocr',
        },
      },
    });
    // Role は executionRoleArn 参照で依存関係が張られるが、DefaultPolicy の反映より
    // 先に Model 作成が走るケースを避けるため明示依存を追加する。
    const roleDefaultPolicy = executionRole.node.tryFindChild('DefaultPolicy');
    if (roleDefaultPolicy) {
      model.node.addDependency(roleDefaultPolicy);
    }
    model.node.addDependency(modelUploaderResource);

    const endpointConfig = new sagemaker.CfnEndpointConfig(
      this,
      'OcrEndpointConfig',
      {
        productionVariants: [
          {
            variantName: this.variantName,
            modelName: model.attrModelName,
            instanceType,
            initialInstanceCount: 1,
            modelDataDownloadTimeoutInSeconds: 1200,
            containerStartupHealthCheckTimeoutInSeconds: 3600,
          },
        ],
        asyncInferenceConfig: {
          outputConfig: {
            s3OutputPath: asyncOutputPath,
            s3FailurePath: asyncFailurePath,
          },
          clientConfig: {
            maxConcurrentInvocationsPerInstance: 4,
          },
        },
      },
    );
    endpointConfig.addDependency(model);

    const endpoint = new sagemaker.CfnEndpoint(this, 'OcrEndpoint', {
      endpointName: `${projectName}-paddleocr-vl`,
      endpointConfigName: endpointConfig.attrEndpointConfigName,
    });
    endpoint.addDependency(endpointConfig);
    this.endpointName = endpoint.attrEndpointName;

    // ========================================
    // Application Auto Scaling（scale-to-0）
    // ========================================
    const scalableTarget = new appscaling.ScalableTarget(
      this,
      'OcrScaling',
      {
        serviceNamespace: appscaling.ServiceNamespace.SAGEMAKER,
        scalableDimension: 'sagemaker:variant:DesiredInstanceCount',
        resourceId: `endpoint/${endpoint.attrEndpointName}/variant/${this.variantName}`,
        minCapacity: 0,
        maxCapacity: 1,
      },
    );
    scalableTarget.node.addDependency(endpoint);

    // スケールイン（1→0）：バックログ件数/インスタンスを指標にする
    scalableTarget.scaleToTrackMetric('OcrBacklogTracking', {
      targetValue: 1,
      customMetric: new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'ApproximateBacklogSizePerInstance',
        dimensionsMap: { EndpointName: endpoint.attrEndpointName },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      }),
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    // スケールアウト（0→1）：容量ゼロでバックログが発生したら 1 台起動する
    scalableTarget.scaleOnMetric('OcrScaleFromZero', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'HasBacklogWithoutCapacity',
        dimensionsMap: { EndpointName: endpoint.attrEndpointName },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [
        { lower: 0, upper: 1, change: 0 },
        { lower: 1, change: +1 },
      ],
      cooldown: cdk.Duration.minutes(1),
    });

    new cdk.CfnOutput(this, 'OcrEndpointName', {
      value: this.endpointName,
      description: 'PaddleOCR asynchronous inference endpoint name',
    });
    new cdk.CfnOutput(this, 'OcrImageUri', {
      value: imageUri,
      description: 'Referenced BYOC image URI',
    });
    new cdk.CfnOutput(this, 'OcrModelDataUrl', {
      value: modelDataUrl,
      description: 'S3 URI for model.tar.gz',
    });
    new cdk.CfnOutput(this, 'OcrAsyncOutputPath', {
      value: asyncOutputPath,
      description: 'S3 prefix for async inference outputs',
    });
  }
}
