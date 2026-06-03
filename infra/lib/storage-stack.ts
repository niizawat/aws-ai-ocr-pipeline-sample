import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  readonly projectName?: string;
}

/**
 * ストレージスタック
 * S3 バケット（raw/images/results/review）と DynamoDB テーブルを管理する
 */
export class StorageStack extends cdk.Stack {
  public readonly reportBucket: s3.IBucket;
  public readonly reportTable: dynamodb.ITable;

  constructor(scope: Construct, id: string, props?: StorageStackProps) {
    super(scope, id, props);

    const projectName = props?.projectName ?? 'quality-report';
    const region = cdk.Stack.of(this).region;

    // S3 アクセスログ用バケット
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `${projectName}-s3-logs-${cdk.Aws.ACCOUNT_ID}-${region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
      ],
    });

    // S3 バケット: レポート格納用（プレフィックスで用途を分離）
    this.reportBucket = new s3.Bucket(this, 'ReportBucket', {
      bucketName: `${projectName}-reports-${cdk.Aws.ACCOUNT_ID}-${region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'report-bucket/',
      lifecycleRules: [
        {
          id: 'delete-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // DynamoDB テーブル: レポートメタデータ・処理ステータス管理
    const table = new dynamodb.Table(this, 'ReportTable', {
      tableName: `${projectName}-reports`,
      partitionKey: {
        name: 'report_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'page_section',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // GSI: 処理ステータス別検索
    table.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'review_status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'extracted_at',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI: 日付別検索
    table.addGlobalSecondaryIndex({
      indexName: 'date-index',
      partitionKey: {
        name: 'report_date',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'report_id',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.reportTable = table;
  }
}
