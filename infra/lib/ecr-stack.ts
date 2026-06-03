import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  readonly projectName?: string;
}

const ECR_LIFECYCLE_RULES: ecr.LifecycleRule[] = [
  {
    rulePriority: 1,
    description: 'Keep last 10 images',
    maxImageCount: 10,
  },
];

/**
 * ECR リポジトリスタック
 * コンテナイメージリポジトリをセキュリティ設定付きで一元管理する。
 * OCR / LibreOffice / Web(Next.js) は CodeBuild でビルドする。
 */
export class EcrStack extends cdk.Stack {
  public readonly ocrRepository: ecr.IRepository;
  /** PaddleOCR 公式 genai vLLM ベースイメージの ECR ミラー */
  public readonly paddleocrBaseRepository: ecr.IRepository;
  public readonly libreOfficeRepository: ecr.IRepository;
  /** Next.js (Material UI) フロントエンドのコンテナイメージ */
  public readonly webRepository: ecr.IRepository;

  constructor(scope: Construct, id: string, props?: EcrStackProps) {
    super(scope, id, props);

    const projectName = props?.projectName ?? 'quality-report';

    // OCR アプリ/ベースイメージは CodeBuild で固定タグ（例: 1.6-vllm）に再プッシュ
    // して反復するため MUTABLE とする。
    this.ocrRepository = new ecr.Repository(this, 'OcrRepository', {
      repositoryName: `${projectName}/paddleocr-vl`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: ECR_LIFECYCLE_RULES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    this.paddleocrBaseRepository = new ecr.Repository(
      this,
      'PaddleocrBaseRepository',
      {
        repositoryName: `${projectName}/paddleocr-base`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        lifecycleRules: ECR_LIFECYCLE_RULES,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      },
    );

    this.libreOfficeRepository = new ecr.Repository(
      this,
      'LibreOfficeRepository',
      {
        repositoryName: `${projectName}/libreoffice`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.MUTABLE,
        lifecycleRules: ECR_LIFECYCLE_RULES,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      },
    );

    this.webRepository = new ecr.Repository(this, 'WebRepository', {
      repositoryName: `${projectName}/web`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: ECR_LIFECYCLE_RULES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
