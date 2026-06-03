import * as path from 'path';
import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib/core';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

/** OCR アプリイメージの既定タグ。 */
export const OCR_DEFAULT_IMAGE_TAG = 'latest';

export interface CodeBuildStackProps extends cdk.StackProps {
  readonly projectName?: string;
  readonly ocrRepository: ecr.IRepository;
}

/**
 * aws-ocr-vision-lab と同じ「CDKデプロイ時に CustomResource で CodeBuild を起動し、
 * isComplete で完了待ちする」方式。
 */
export class CodeBuildStack extends cdk.Stack {
  public readonly buildProjectName: string;

  constructor(scope: Construct, id: string, props: CodeBuildStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const appUri = props.ocrRepository.repositoryUri;
    const region = cdk.Stack.of(this).region;

    const sourceAsset = new Asset(this, 'OcrBuildContext', {
      path: path.join(__dirname, '..', 'containers', 'paddleocr-vl-sagemaker'),
    });
    const buildContextHash = crypto
      .createHash('md5')
      .update(sourceAsset.assetHash)
      .digest('hex')
      .substring(0, 8);

    const build = new codebuild.Project(this, 'OcrBuildProject', {
      projectName: `${projectName}-ocr-build`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      timeout: cdk.Duration.hours(1),
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environmentVariables: {
        AWS_ACCOUNT_ID: { value: this.account },
        APP_ECR_URI: { value: appUri },
        APP_TAG: { value: OCR_DEFAULT_IMAGE_TAG },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com"',
              'echo Logging in to SageMaker ECR for base image...',
              `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin 763104351884.dkr.ecr.${region}.amazonaws.com`,
            ],
          },
          build: {
            commands: [
              'echo Building OCR Docker image...',
              `docker pull 763104351884.dkr.ecr.${region}.amazonaws.com/pytorch-inference:2.2.0-gpu-py310-cu118-ubuntu20.04-sagemaker`,
              'DOCKER_BUILDKIT=0 docker build --build-arg REGION="$AWS_DEFAULT_REGION" -t "$APP_ECR_URI:$APP_TAG" .',
            ],
          },
          post_build: {
            commands: [
              'echo Pushing Docker image...',
              'docker push "$APP_ECR_URI:$APP_TAG"',
              'echo Docker build completed successfully',
            ],
          },
        },
      }),
    });
    props.ocrRepository.grantPullPush(build);
    sourceAsset.grantRead(build);
    build.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    // SageMaker DLC ECR (763104351884) からベースイメージを pull する権限
    build.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [`arn:aws:ecr:${region}:763104351884:repository/*`],
      }),
    );
    this.buildProjectName = build.projectName;

    const buildTriggerPath = path.join(__dirname, '..', 'lambda', 'build-trigger');
    const onEvent = new lambda.Function(this, 'OcrBuildOnEventFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'on_event.handler',
      code: lambda.Code.fromAsset(buildTriggerPath),
      timeout: cdk.Duration.seconds(60),
    });
    const isComplete = new lambda.Function(this, 'OcrBuildIsCompleteFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'is_complete.handler',
      code: lambda.Code.fromAsset(buildTriggerPath),
      timeout: cdk.Duration.seconds(60),
    });
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [build.projectArn],
      }),
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:BatchGetBuilds'],
        resources: [build.projectArn],
      }),
    );

    const provider = new Provider(this, 'OcrBuildProvider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(90),
    });
    const trigger = new cdk.CustomResource(this, 'OcrBuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: build.projectName,
        BuildContextHash: buildContextHash,
      },
    });
    trigger.node.addDependency(build);
    trigger.node.addDependency(sourceAsset);

    new cdk.CfnOutput(this, 'OcrBuildProjectName', {
      value: this.buildProjectName,
      description: 'CodeBuild project name for OCR image build',
    });
    new cdk.CfnOutput(this, 'OcrImageUri', {
      value: `${appUri}:${OCR_DEFAULT_IMAGE_TAG}`,
      description: 'OCR image URI after build (referenced by OcrStack)',
    });
  }
}
