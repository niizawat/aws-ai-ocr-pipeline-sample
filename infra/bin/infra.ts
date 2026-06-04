#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { StorageStack } from '../lib/storage-stack';
import { EcrStack } from '../lib/ecr-stack';
import {
  EcrDeployStack,
  LIBREOFFICE_IMAGE_TAG,
  WEB_IMAGE_TAG,
} from '../lib/ecr-deploy-stack';
import { CodeBuildStack, OCR_DEFAULT_IMAGE_TAG } from '../lib/codebuild-stack';
import { OcrStack } from '../lib/ocr-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { ReviewStack } from '../lib/review-stack';
import { AnalysisStack } from '../lib/analysis-stack';

const app = new cdk.App();

const projectName = 'quality-report';
const deployRegion = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const vectorBucketName = `${projectName}-vectors-${deployRegion}`;
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: deployRegion,
};

// Phase 1: ストレージ
const storageStack = new StorageStack(app, 'QualityReportStorageStack', {
  env,
  projectName,
  description: 'Quality report platform - Storage (S3, DynamoDB)',
});

// ECR リポジトリ（セキュリティ設定付き）
const ecrStack = new EcrStack(app, 'QualityReportEcrStack', {
  env,
  projectName,
  description: 'Quality report platform - ECR repositories',
});

// Docker イメージビルド & ECR 同期（LibreOffice / Web のみ）
const ecrDeployStack = new EcrDeployStack(app, 'QualityReportEcrDeployStack', {
  env,
  projectName,
  libreOfficeRepository: ecrStack.libreOfficeRepository,
  webRepository: ecrStack.webRepository,
  description:
    'Quality report platform - CodeBuild (LibreOffice/Web image build)',
});
ecrDeployStack.addDependency(ecrStack);

// OCR イメージを CodeBuild で ECR へ用意するスタック
const codeBuildStack = new CodeBuildStack(app, 'QualityReportCodeBuildStack', {
  env,
  projectName,
  ocrRepository: ecrStack.ocrRepository,
  description: 'Quality report platform - CodeBuild (OCR image build)',
});
codeBuildStack.addDependency(ecrStack);

// Phase 3: OCR 推論基盤（SageMaker 非同期推論エンドポイント / scale-to-0）
const ocrImageTag =
  (app.node.tryGetContext('ocrImageTag') as string | undefined) ??
  OCR_DEFAULT_IMAGE_TAG;
const ocrStack = new OcrStack(app, 'QualityReportOcrStack', {
  env,
  projectName,
  reportBucket: storageStack.reportBucket,
  ocrRepository: ecrStack.ocrRepository,
  ocrImageTag,
  instanceType: 'ml.g4dn.xlarge',
  description: 'Quality report platform - OCR (SageMaker async inference / BYOC)',
});
ocrStack.addDependency(storageStack);
ocrStack.addDependency(ecrStack);
ocrStack.addDependency(codeBuildStack);

// Phase 4: Human Review
const reviewStack = new ReviewStack(app, 'QualityReportReviewStack', {
  env,
  projectName,
  reportBucket: storageStack.reportBucket,
  description: 'Quality report platform - A2I human review',
});
reviewStack.addDependency(storageStack);

// Phase 2: パイプライン（VPC なし / Lambda はパブリック実行）
const pipelineStack = new PipelineStack(app, 'QualityReportPipelineStack', {
  env,
  projectName,
  reportBucket: storageStack.reportBucket,
  reportTable: storageStack.reportTable,
  libreOfficeRepository: ecrStack.libreOfficeRepository,
  libreOfficeImageTag: LIBREOFFICE_IMAGE_TAG,
  flowDefinitionArn: reviewStack.flowDefinitionArn,
  ocrEndpointName: ocrStack.endpointName,
  vectorBucketName,
  description: 'Quality report platform - Pipeline (SQS, Step Functions, Lambda)',
});
pipelineStack.addDependency(storageStack);
pipelineStack.addDependency(ecrDeployStack);
pipelineStack.addDependency(reviewStack);
pipelineStack.addDependency(ocrStack);
pipelineStack.addDependency(codeBuildStack);

// Phase 5: 分析・可視化（Next.js on Lambda / VPC なし）
const analysisStack = new AnalysisStack(app, 'QualityReportAnalysisStack', {
  env,
  projectName,
  reportBucket: storageStack.reportBucket,
  reportTable: storageStack.reportTable,
  flowDefinitionArn: reviewStack.flowDefinitionArn,
  workteamName: reviewStack.workteamName,
  webRepository: ecrStack.webRepository,
  webImageTag: WEB_IMAGE_TAG,
  domainName: 'quality-report.zawanee.online',
  hostedZoneId: 'Z0366399YFI0M7IVDEGG',
  hostedZoneName: 'zawanee.online',
  description:
    'Quality report platform - Analytics (Next.js Lambda, S3 Vectors, Cognito, HTTPS)',
});
analysisStack.addDependency(storageStack);
analysisStack.addDependency(ecrDeployStack);
analysisStack.addDependency(reviewStack);
