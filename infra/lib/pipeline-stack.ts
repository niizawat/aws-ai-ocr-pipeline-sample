import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import type { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly ecsFargateSg: ec2.ISecurityGroup;
  readonly reportBucket: s3.IBucket;
  readonly reportTable: dynamodb.ITable;
  readonly libreOfficeRepository: ecr.IRepository;
  readonly libreOfficeImageTag: string;
  readonly flowDefinitionArn: string;
  /** PaddleOCR-VL を実行する SageMaker 非同期推論エンドポイント名 */
  readonly ocrEndpointName: string;
  readonly projectName?: string;
  /** RAG 用ベクトルインデックスを保持する S3 Vectors バケット名 */
  readonly vectorBucketName: string;
  /** S3 Vectors インデックス名（デフォルト: report-embeddings） */
  readonly vectorIndexName?: string;
}

/** OCR バッチ結果 JSON の S3 プレフィックス（バッチタスクと結果読取り Lambda で共有） */
const OCR_RESULT_PREFIX = 'ocr-results/';

/** requirements.txt 付き Python Lambda 向けの pip バンドリング */
function pythonRequirementsAsset(
  assetPath: string,
  runtime: lambda.Runtime,
  platform?: string,
): lambda.AssetCode {
  return lambda.Code.fromAsset(assetPath, {
    bundling: {
      image: runtime.bundlingImage,
      ...(platform ? { platform } : {}),
      command: [
        'bash',
        '-c',
        'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
      ],
    },
  });
}

/**
 * ファイル処理パイプラインスタック
 * EventBridge Rule、SQS + DLQ、EventBridge Pipe、
 * Step Functions ワークフローと Lambda 関数群（LibreOffice 変換 Lambda を含む）を管理する
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const PYTHON_RUNTIME = lambda.Runtime.PYTHON_3_13;

    // ========================================
    // SQS DLQ + メインキュー
    // ========================================
    const dlq = new sqs.Queue(this, 'ProcessingDlq', {
      queueName: `${projectName}-processing-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: `${projectName}-processing-queue`,
      visibilityTimeout: cdk.Duration.seconds(900),
      retentionPeriod: cdk.Duration.days(7),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 5,
      },
    });

    // ========================================
    // EventBridge Rule: S3 raw/ プレフィックスへの PutObject 検知
    // ========================================
    const s3UploadRule = new events.Rule(this, 'S3UploadRule', {
      ruleName: `${projectName}-s3-upload-rule`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.reportBucket.bucketName] },
          object: { key: [{ prefix: 'raw/' }] },
        },
      },
    });
    s3UploadRule.addTarget(new events_targets.SqsQueue(queue));

    // ========================================
    // Lambda 関数群
    // ========================================
    const lambdaDefaults = {
      runtime: PYTHON_RUNTIME,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } as ec2.SubnetSelection,
      securityGroups: [props.lambdaSg],
    };

    // PyMuPDF でページ品質を確認するためネイティブ依存が必要。
    // テキスト抽出のみ（画像化なし）なので 512MB で十分（設計書 §Phase3 注記）。
    const classifyFileFn = new lambda.Function(this, 'ClassifyFileFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-classify-file`,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: pythonRequirementsAsset(
        path.join(__dirname, '../lambda/classify-file'),
        PYTHON_RUNTIME,
        'linux/arm64',
      ),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
      },
    });
    props.reportBucket.grantRead(classifyFileFn);

    const extractExcelFn = new lambda.Function(this, 'ExtractExcelFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-extract-excel`,
      handler: 'handler.handler',
      code: pythonRequirementsAsset(
        path.join(__dirname, '../lambda/extract-excel'),
        PYTHON_RUNTIME,
      ),
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
      },
    });
    props.reportBucket.grantRead(extractExcelFn);

    // PyMuPDF + pymupdf4llm + numpy はネイティブ依存かつ大容量のため
    // render-pdf-images と同様に arm64 固定・メモリ増量する（設計書 §7.2 注意点）。
    const extractPdfTextFn = new lambda.Function(this, 'ExtractPdfTextFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-extract-pdf-text`,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: pythonRequirementsAsset(
        path.join(__dirname, '../lambda/extract-pdf-text'),
        PYTHON_RUNTIME,
        'linux/arm64',
      ),
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
      },
    });
    props.reportBucket.grantRead(extractPdfTextFn);

    const normalizeResultsFn = new lambda.Function(this, 'NormalizeResultsFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-normalize-results`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/normalize-results')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
    });

    const storeResultsFn = new lambda.Function(this, 'StoreResultsFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-store-results`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/store-results')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        TABLE_NAME: props.reportTable.tableName,
      },
    });
    props.reportBucket.grantReadWrite(storeResultsFn);
    props.reportTable.grantWriteData(storeResultsFn);

    const vectorIndexName = props.vectorIndexName ?? 'report-embeddings';
    const indexEmbeddingsFn = new lambda.Function(this, 'IndexEmbeddingsFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-index-embeddings`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/index-embeddings')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        VECTOR_BUCKET: props.vectorBucketName,
        VECTOR_INDEX: vectorIndexName,
      },
    });
    props.reportBucket.grantRead(indexEmbeddingsFn);
    indexEmbeddingsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      }),
    );
    indexEmbeddingsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:PutVectors'],
        resources: [
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${props.vectorBucketName}/index/${vectorIndexName}`,
        ],
      }),
    );

    // SageMaker 非同期推論の出力/失敗オブジェクトを S3 で確認し、後続契約へ整形する
    const readOcrResultFn = new lambda.Function(this, 'InvokeOcrFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-invoke-ocr`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/invoke-ocr')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        OCR_RESULT_PREFIX,
      },
    });
    props.reportBucket.grantReadWrite(readOcrResultFn);

    // 写真の意味解釈は Bedrock Kimi K2.5（マルチモーダル）に分担する。
    // PyMuPDF/Pillow を Docker バンドリングで同梱する（デプロイ時に Docker が必要）。
    const bedrockModelId = 'moonshotai.kimi-k2.5';
    const interpretPhotoFn = new lambda.Function(this, 'InterpretPhotoFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-interpret-photo`,
      handler: 'handler.handler',
      // ネイティブ依存（PyMuPDF/Pillow）の arch を確定させるため Lambda と
      // バンドリングを共に arm64 に固定する（Graviton。コスト面でも有利）。
      architecture: lambda.Architecture.ARM_64,
      code: pythonRequirementsAsset(
        path.join(__dirname, '../lambda/interpret-photo'),
        PYTHON_RUNTIME,
        'linux/arm64',
      ),
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
    });
    props.reportBucket.grantRead(interpretPhotoFn);
    interpretPhotoFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/${bedrockModelId}`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );

    // xlsx-with-shapes 向けの LibreOffice 変換を Lambda コンテナで実行する。
    // xlsx を PDF へ変換し、変換後 PDF をそのまま OCR へ接続する。
    const libreOfficeConvertFn = new lambda.DockerImageFunction(
      this,
      'LibreOfficeConvertFn',
      {
        functionName: `${projectName}-libreoffice-convert`,
        code: lambda.DockerImageCode.fromEcr(props.libreOfficeRepository, {
          tagOrDigest: props.libreOfficeImageTag,
        }),
        timeout: cdk.Duration.minutes(15),
        memorySize: 3072,
        architecture: lambda.Architecture.ARM_64,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.lambdaSg],
      },
    );
    props.reportBucket.grantReadWrite(libreOfficeConvertFn);

    // scan-pdf 向け: プレビュー用ページ PNG を images/{report_id}/ へ生成する
    const renderPdfImagesFn = new lambda.Function(this, 'RenderPdfImagesFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-render-pdf-images`,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.handler',
      code: pythonRequirementsAsset(
        path.join(__dirname, '../lambda/render-pdf-images'),
        PYTHON_RUNTIME,
        'linux/arm64',
      ),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
      },
    });
    props.reportBucket.grantReadWrite(renderPdfImagesFn);

    const triggerReviewFn = new lambda.Function(this, 'TriggerReviewFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-trigger-review`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/trigger-review')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        FLOW_DEFINITION_ARN: props.flowDefinitionArn,
        TABLE_NAME: props.reportTable.tableName,
      },
    });
    props.reportBucket.grantRead(triggerReviewFn);
    props.reportBucket.grantPut(triggerReviewFn, 'review-tokens/*');
    props.reportTable.grantWriteData(triggerReviewFn);
    triggerReviewFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:StartHumanLoop'],
        resources: [props.flowDefinitionArn],
      }),
    );

    const reviewCompleteFn = new lambda.Function(this, 'ReviewCompleteFn', {
      ...lambdaDefaults,
      functionName: `${projectName}-review-complete`,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/review-complete')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        REPORT_BUCKET: props.reportBucket.bucketName,
        TABLE_NAME: props.reportTable.tableName,
      },
    });
    reviewCompleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:DescribeHumanLoop'],
        resources: [
          `arn:aws:sagemaker:${this.region}:${this.account}:human-loop/*`,
        ],
      }),
    );
    reviewCompleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: [
          `arn:aws:states:${this.region}:${this.account}:stateMachine:${projectName}-*`,
          `arn:aws:states:${this.region}:${this.account}:execution:${projectName}-*:*`,
        ],
      }),
    );
    props.reportBucket.grantRead(reviewCompleteFn);
    props.reportTable.grantWriteData(reviewCompleteFn);

    // A2I 完了イベント → review-complete Lambda
    new events.Rule(this, 'A2ICompletionRule', {
      ruleName: `${projectName}-a2i-completion`,
      eventPattern: {
        source: ['aws.sagemaker'],
        detailType: ['SageMaker A2I HumanLoop Status Change'],
        // A2I イベント detail は camelCase（humanLoopStatus）
        detail: { humanLoopStatus: ['Completed'] },
      },
      targets: [new events_targets.LambdaFunction(reviewCompleteFn)],
    });

    // ========================================
    // OCR 実行サブチェーン（SageMaker 非同期推論 + S3 ポーリング）
    // ========================================
    // 非同期エンドポイントへ S3 上の入力を投入（scale-to-0 から自動起動）し、
    // 出力が S3 に生成されるまで Wait → Check(Lambda) → Choice のループで待機する。
    const ocrEndpointArn = `arn:aws:sagemaker:${this.region}:${this.account}:endpoint/${props.ocrEndpointName}`;

    const buildOcrAsync = (
      idPrefix: string,
      inputKeyPath: string,
      onReady: sfn.IChainable,
    ): sfn.State => {
      const submit = new sfn.CustomState(this, `${idPrefix}Submit`, {
        stateJson: {
          Type: 'Task',
          Resource:
            'arn:aws:states:::aws-sdk:sagemakerruntime:invokeEndpointAsync',
          Parameters: {
            EndpointName: props.ocrEndpointName,
            ContentType: 'application/octet-stream',
            'InputLocation.$': `States.Format('s3://{}/{}', $.bucket, ${inputKeyPath})`,
          },
          // 非同期 API の応答（OutputLocation/FailureLocation/InferenceId）を引き継ぐ
          ResultPath: '$.ocrAsync',
        },
      });
      const wait = new sfn.Wait(this, `${idPrefix}Wait`, {
        time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
      });
      const check = new tasks.LambdaInvoke(this, `${idPrefix}Check`, {
        lambdaFunction: readOcrResultFn,
        payloadResponseOnly: true,
      });
      const choice = new sfn.Choice(this, `${idPrefix}ReadyChoice`);

      submit.next(wait);
      wait.next(check);
      check.next(
        choice
          .when(sfn.Condition.booleanEquals('$.ocrReady', true), onReady)
          .otherwise(wait),
      );
      return submit;
    };

    // PyMuPDF テキスト等の既存フィールドを保持したまま OCR 結果を $.ocrCheck に合流する
    // ハイブリッド処理（テキスト抽出 + 画像/グラフ OCR）向け
    const buildOcrAsyncMerge = (
      idPrefix: string,
      inputKeyPath: string,
      onReady: sfn.IChainable,
    ): sfn.State => {
      const submit = new sfn.CustomState(this, `${idPrefix}Submit`, {
        stateJson: {
          Type: 'Task',
          Resource:
            'arn:aws:states:::aws-sdk:sagemakerruntime:invokeEndpointAsync',
          Parameters: {
            EndpointName: props.ocrEndpointName,
            ContentType: 'application/octet-stream',
            'InputLocation.$': `States.Format('s3://{}/{}', $.bucket, ${inputKeyPath})`,
          },
          ResultPath: '$.ocrAsync',
        },
      });
      const wait = new sfn.Wait(this, `${idPrefix}Wait`, {
        time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
      });
      // resultPath で既存フィールドを保持したまま OCR チェック結果を $.ocrCheck に格納
      const check = new tasks.LambdaInvoke(this, `${idPrefix}Check`, {
        lambdaFunction: readOcrResultFn,
        resultPath: '$.ocrCheck',
      });
      const choice = new sfn.Choice(this, `${idPrefix}ReadyChoice`);

      submit.next(wait);
      wait.next(check);
      check.next(
        choice
          // resultPath 使用のため Payload でラップされた ocrReady を参照する
          .when(sfn.Condition.booleanEquals('$.ocrCheck.Payload.ocrReady', true), onReady)
          .otherwise(wait),
      );
      return submit;
    };

    // ========================================
    // Step Functions ワークフロー定義
    // ========================================

    // --- 共通: 完了状態 ---
    const done = new sfn.Succeed(this, 'Done');

    // IndexEmbeddings タスクファクトリ: 同一 Lambda を各パスで独立したステートとして使う
    const makeIndexTask = (id: string) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: indexEmbeddingsFn,
        payloadResponseOnly: true,
      });

    // --- digital-pdf パス ---
    const extractPdfText = new tasks.LambdaInvoke(this, 'ExtractPdfText', {
      lambdaFunction: extractPdfTextFn,
      payloadResponseOnly: true,
    });

    // --- digital-pdf: 品質 OK 経路（PyMuPDF テキスト直行） ---
    const normalizePdf = new tasks.LambdaInvoke(this, 'NormalizePdf', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storePdf = new tasks.LambdaInvoke(this, 'StorePdf', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });

    // --- digital-pdf: OCR フォールバック経路（設計書 §7.2 ハイブリッドルーティング）---
    // analyze_page() が needs_ocr=true と判定したページが存在する場合、
    // scan-pdf と同じ OCR 非同期ループを再利用して全ページを OCR 処理する。
    // render-pdf-images → buildOcrAsync → confidence 判定 → normalize/store/index
    const normalizePdfFallbackHigh = new tasks.LambdaInvoke(this, 'NormalizePdfFallbackHigh', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storePdfFallbackHigh = new tasks.LambdaInvoke(this, 'StorePdfFallbackHigh', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    const triggerReviewPdfFallback = new tasks.LambdaInvoke(
      this,
      'TriggerReviewPdfFallback',
      {
        lambdaFunction: triggerReviewFn,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          taskToken: sfn.JsonPath.taskToken,
          'input.$': '$',
        }),
        heartbeatTimeout: sfn.Timeout.duration(cdk.Duration.hours(48)),
      },
    );
    const normalizePdfFallbackReview = new tasks.LambdaInvoke(
      this,
      'NormalizePdfFallbackReview',
      {
        lambdaFunction: normalizeResultsFn,
        payloadResponseOnly: true,
      },
    );
    const storePdfFallbackReview = new tasks.LambdaInvoke(this, 'StorePdfFallbackReview', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });

    const confidenceCheckPdfFallback = new sfn.Choice(this, 'ConfidenceCheckPdfFallback')
      .when(
        sfn.Condition.numberGreaterThanEquals('$.confidence', 0.7),
        normalizePdfFallbackHigh
          .next(storePdfFallbackHigh)
          .next(makeIndexTask('IndexEmbeddingsPdfFallbackHigh'))
          .next(done),
      )
      .otherwise(
        triggerReviewPdfFallback
          .next(normalizePdfFallbackReview)
          .next(storePdfFallbackReview)
          .next(makeIndexTask('IndexEmbeddingsPdfFallbackReview'))
          .next(done),
      );

    // OCR ポーリングが完了したら confidence 判定へ（scan-pdf の OcrScanReady に相当）
    const ocrPdfFallbackReady = new sfn.Pass(this, 'OcrPdfFallbackReady');
    ocrPdfFallbackReady.next(confidenceCheckPdfFallback);

    // RenderPdfImagesFallback: scan-pdf の RenderPdfImagesScan と同じ Lambda を別ステートで再利用
    const renderPdfImagesFallback = new tasks.LambdaInvoke(this, 'RenderPdfImagesFallback', {
      lambdaFunction: renderPdfImagesFn,
      payloadResponseOnly: true,
    });
    renderPdfImagesFallback.next(
      buildOcrAsync('OcrPdfFallback', '$.key', ocrPdfFallbackReady),
    );

    // pdfOcrCheck: hasPagesNeedOcr フラグで経路を切り替える
    const pdfOcrCheck = new sfn.Choice(this, 'PdfOcrCheck')
      .when(
        sfn.Condition.booleanEquals('$.hasPagesNeedOcr', true),
        renderPdfImagesFallback,
      )
      .otherwise(
        normalizePdf
          .next(storePdf)
          .next(makeIndexTask('IndexEmbeddingsPdf'))
          .next(done),
      );

    const pdfChain = extractPdfText.next(pdfOcrCheck);

    // --- scan-pdf パス ---
    const normalizeOcrHigh = new tasks.LambdaInvoke(this, 'NormalizeOcrHigh', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storeOcrHigh = new tasks.LambdaInvoke(this, 'StoreOcrHigh', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    const triggerReviewScan = new tasks.LambdaInvoke(this, 'TriggerReviewScan', {
      lambdaFunction: triggerReviewFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        'input.$': '$',
      }),
      heartbeatTimeout: sfn.Timeout.duration(cdk.Duration.hours(48)),
    });
    const normalizeOcrReview = new tasks.LambdaInvoke(
      this,
      'NormalizeOcrReview',
      {
        lambdaFunction: normalizeResultsFn,
        payloadResponseOnly: true,
      },
    );
    const storeOcrReview = new tasks.LambdaInvoke(this, 'StoreOcrReview', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });

    const confidenceCheckScan = new sfn.Choice(this, 'ConfidenceCheckScan')
      .when(
        sfn.Condition.numberGreaterThanEquals('$.confidence', 0.7),
        normalizeOcrHigh
          .next(storeOcrHigh)
          .next(makeIndexTask('IndexEmbeddingsOcrHigh'))
          .next(done),
      )
      .otherwise(
        triggerReviewScan
          .next(normalizeOcrReview)
          .next(storeOcrReview)
          .next(makeIndexTask('IndexEmbeddingsOcrReview'))
          .next(done),
      );

    // 文字/表/グラフ（PaddleOCR-VL）と写真解釈（Bedrock Kimi K2.5）を並列実行し、結合する
    const ocrScanReady = new sfn.Pass(this, 'OcrScanReady');
    const interpretPhotoScan = new tasks.LambdaInvoke(this, 'InterpretPhotoScan', {
      lambdaFunction: interpretPhotoFn,
      payloadResponseOnly: true,
    });

    const parallelScan = new sfn.Parallel(this, 'ParallelScanProcessing');
    parallelScan.branch(buildOcrAsync('OcrScan', '$.key', ocrScanReady));
    parallelScan.branch(interpretPhotoScan);

    const mergeScanResults = new sfn.Pass(this, 'MergeScanResults', {
      parameters: {
        'bucket.$': '$[0].bucket',
        'key.$': '$[0].key',
        'report_id.$': '$[0].report_id',
        extractionType: 'ocr',
        'confidence.$': '$[0].confidence',
        'ocrResults.$': '$[0].ocrResults',
        'photoInterpretations.$': '$[1].photoInterpretations',
      },
    });

    const renderPdfImagesScan = new tasks.LambdaInvoke(this, 'RenderPdfImagesScan', {
      lambdaFunction: renderPdfImagesFn,
      payloadResponseOnly: true,
    });

    const scanPdfChain = renderPdfImagesScan
      .next(parallelScan)
      .next(mergeScanResults)
      .next(confidenceCheckScan);

    // --- xlsx-with-shapes パス ---
    const extractExcelShapes = new tasks.LambdaInvoke(
      this,
      'ExtractExcelShapes',
      {
        lambdaFunction: extractExcelFn,
        payloadResponseOnly: true,
      },
    );

    const libreOfficeConvert = new tasks.LambdaInvoke(this, 'LibreOfficeConvert', {
      lambdaFunction: libreOfficeConvertFn,
      payloadResponseOnly: true,
    });

    // --- xlsx-with-shapes パス: PyMuPDF テキスト抽出必須 + 画像/グラフがあれば OCR も実行 ---
    const extractPdfTextShapes = new tasks.LambdaInvoke(this, 'ExtractPdfTextShapes', {
      lambdaFunction: extractPdfTextFn,
      payloadResponseOnly: true,
    });

    const parallelShapes = new sfn.Parallel(this, 'ParallelShapesProcessing');
    parallelShapes.branch(extractExcelShapes);
    parallelShapes.branch(libreOfficeConvert.next(extractPdfTextShapes));

    // Parallel 後: [$excelShapes, $pdfText] を単一オブジェクトへ展開（画像判定フラグ含む）
    const preMergeShapes = new sfn.Pass(this, 'PreMergeShapes', {
      parameters: {
        'bucket.$': '$[1].bucket',
        'key.$': '$[1].key',
        'report_id.$': '$[1].report_id',
        'hasPagesNeedOcr.$': '$[1].hasPagesNeedOcr',
        'pages.$': '$[1].pages',
        'fullText.$': '$[1].fullText',
        'pageCount.$': '$[1].pageCount',
        'excelData.$': '$[0]',
      },
    });

    // --- xlsx OCR なし（テキストのみ） ---
    const setExcelPdfText = new sfn.Pass(this, 'SetExcelPdfText', {
      parameters: {
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        'report_id.$': '$.report_id',
        'extractionType': 'excel-pymupdf',
        'excelData.$': '$.excelData',
        'pages.$': '$.pages',
        'fullText.$': '$.fullText',
        'pageCount.$': '$.pageCount',
        'confidence': 1.0,
      },
    });
    const normalizeShapesPdfHigh = new tasks.LambdaInvoke(this, 'NormalizeShapesPdfHigh', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storeShapesPdfHigh = new tasks.LambdaInvoke(this, 'StoreShapesPdfHigh', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    setExcelPdfText
      .next(normalizeShapesPdfHigh)
      .next(storeShapesPdfHigh)
      .next(makeIndexTask('IndexEmbeddingsShapesPdfHigh'))
      .next(done);

    // --- xlsx ハイブリッド（PyMuPDF テキスト + 画像/グラフ OCR）---
    const renderPdfImagesShapes = new tasks.LambdaInvoke(this, 'RenderPdfImagesShapes', {
      lambdaFunction: renderPdfImagesFn,
      payloadResponseOnly: true,
    });
    const ocrShapesHybridReady = new sfn.Pass(this, 'OcrShapesHybridReady');
    const mergeShapesHybrid = new sfn.Pass(this, 'MergeShapesHybrid', {
      parameters: {
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        'report_id.$': '$.report_id',
        'extractionType': 'excel-hybrid',
        'excelData.$': '$.excelData',
        'pages.$': '$.pages',
        'ocrResults.$': '$.ocrCheck.Payload.ocrResults',
        'confidence': 1.0,
      },
    });
    const normalizeShapesHybrid = new tasks.LambdaInvoke(this, 'NormalizeShapesHybrid', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storeShapesHybrid = new tasks.LambdaInvoke(this, 'StoreShapesHybrid', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    ocrShapesHybridReady
      .next(mergeShapesHybrid)
      .next(normalizeShapesHybrid)
      .next(storeShapesHybrid)
      .next(makeIndexTask('IndexEmbeddingsShapesHybrid'))
      .next(done);
    renderPdfImagesShapes.next(
      buildOcrAsyncMerge('OcrShapes', '$.key', ocrShapesHybridReady),
    );

    const shapesOcrCheck = new sfn.Choice(this, 'ShapesOcrCheck')
      .when(sfn.Condition.booleanEquals('$.hasPagesNeedOcr', true), renderPdfImagesShapes)
      .otherwise(setExcelPdfText);

    const shapesChain = parallelShapes
      .next(preMergeShapes)
      .next(shapesOcrCheck);

    // --- docx パス: PyMuPDF テキスト抽出必須 + 画像/グラフがあれば OCR も実行 ---
    const libreOfficeConvertDocx = new tasks.LambdaInvoke(this, 'LibreOfficeConvertDocx', {
      lambdaFunction: libreOfficeConvertFn,
      payloadResponseOnly: true,
    });
    const extractPdfTextDocx = new tasks.LambdaInvoke(this, 'ExtractPdfTextDocx', {
      lambdaFunction: extractPdfTextFn,
      payloadResponseOnly: true,
    });

    // --- docx OCR なし（テキストのみ） ---
    const normalizeDocx = new tasks.LambdaInvoke(this, 'NormalizeDocx', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storeDocx = new tasks.LambdaInvoke(this, 'StoreDocx', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    normalizeDocx
      .next(storeDocx)
      .next(makeIndexTask('IndexEmbeddingsDocx'))
      .next(done);

    // --- docx ハイブリッド（PyMuPDF テキスト + 画像/グラフ OCR）---
    const renderPdfImagesDocx = new tasks.LambdaInvoke(this, 'RenderPdfImagesDocx', {
      lambdaFunction: renderPdfImagesFn,
      payloadResponseOnly: true,
    });
    const ocrDocxHybridReady = new sfn.Pass(this, 'OcrDocxHybridReady');
    const mergeDocxHybrid = new sfn.Pass(this, 'MergeDocxHybrid', {
      parameters: {
        'bucket.$': '$.bucket',
        'key.$': '$.key',
        'report_id.$': '$.report_id',
        'extractionType': 'pdf-hybrid',
        'pages.$': '$.pages',
        'ocrResults.$': '$.ocrCheck.Payload.ocrResults',
        'confidence': 1.0,
      },
    });
    const normalizeDocxHybrid = new tasks.LambdaInvoke(this, 'NormalizeDocxHybrid', {
      lambdaFunction: normalizeResultsFn,
      payloadResponseOnly: true,
    });
    const storeDocxHybrid = new tasks.LambdaInvoke(this, 'StoreDocxHybrid', {
      lambdaFunction: storeResultsFn,
      payloadResponseOnly: true,
    });
    ocrDocxHybridReady
      .next(mergeDocxHybrid)
      .next(normalizeDocxHybrid)
      .next(storeDocxHybrid)
      .next(makeIndexTask('IndexEmbeddingsDocxHybrid'))
      .next(done);
    renderPdfImagesDocx.next(
      buildOcrAsyncMerge('OcrDocx', '$.key', ocrDocxHybridReady),
    );

    const docxOcrCheck = new sfn.Choice(this, 'DocxOcrCheck')
      .when(sfn.Condition.booleanEquals('$.hasPagesNeedOcr', true), renderPdfImagesDocx)
      .otherwise(normalizeDocx);

    const docxChain = libreOfficeConvertDocx
      .next(extractPdfTextDocx)
      .next(docxOcrCheck);

    // --- ファイル種別による分岐 ---
    const classifyFile = new tasks.LambdaInvoke(this, 'ClassifyFile', {
      lambdaFunction: classifyFileFn,
      payloadResponseOnly: true,
    });

    const fileTypeChoice = new sfn.Choice(this, 'FileTypeChoice')
      .when(sfn.Condition.stringEquals('$.fileType', 'digital-pdf'), pdfChain)
      .when(sfn.Condition.stringEquals('$.fileType', 'scan-pdf'), scanPdfChain)
      .when(sfn.Condition.stringEquals('$.fileType', 'xlsx-with-shapes'), shapesChain)
      .when(sfn.Condition.stringEquals('$.fileType', 'docx'), docxChain)
      .otherwise(
        new sfn.Fail(this, 'UnsupportedFileType', {
          cause: 'Unsupported file type',
          error: 'UnsupportedFileTypeError',
        }),
      );

    const definition = classifyFile.next(fileTypeChoice);

    const stateMachine = new sfn.StateMachine(this, 'ProcessingStateMachine', {
      stateMachineName: `${projectName}-file-processing`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(24),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          logGroupName: `/aws/stepfunctions/${projectName}-file-processing`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ERROR,
      },
    });

    props.reportBucket.grantRead(stateMachine);

    // OCR（CustomState の aws-sdk:sagemakerruntime:invokeEndpointAsync）に必要な IAM。
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpointAsync'],
        resources: [ocrEndpointArn],
      }),
    );

    // ========================================
    // EventBridge Pipe: SQS → フィルタ → Step Functions
    // ========================================
    const pipeRole = new iam.Role(this, 'PipeRole', {
      roleName: `${projectName}-pipe-role`,
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    queue.grantConsumeMessages(pipeRole);
    stateMachine.grantStartExecution(pipeRole);

    new pipes.CfnPipe(this, 'S3EventPipe', {
      name: `${projectName}-s3-event-pipe`,
      roleArn: pipeRole.roleArn,
      source: queue.queueArn,
      sourceParameters: {
        filterCriteria: {
          filters: [
            {
              pattern: JSON.stringify({
                body: {
                  detail: {
                    object: {
                      key: [{ suffix: '.xlsx' }, { suffix: '.pdf' }],
                    },
                  },
                },
              }),
            },
          ],
        },
        sqsQueueParameters: {
          batchSize: 1,
        },
      },
      target: stateMachine.stateMachineArn,
      targetParameters: {
        stepFunctionStateMachineParameters: {
          invocationType: 'FIRE_AND_FORGET',
        },
        inputTemplate: JSON.stringify({
          bucket: '<$.body.detail.bucket.name>',
          key: '<$.body.detail.object.key>',
          size: '<$.body.detail.object.size>',
          eventTime: '<$.body.time>',
        }),
      },
    });
  }
}
