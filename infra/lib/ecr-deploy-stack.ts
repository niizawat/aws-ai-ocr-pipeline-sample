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

export const LIBREOFFICE_IMAGE_TAG = 'latest';
export const WEB_IMAGE_TAG = 'latest';

export interface EcrDeployStackProps extends cdk.StackProps {
  readonly projectName?: string;
  readonly libreOfficeRepository: ecr.IRepository;
  readonly webRepository: ecr.IRepository;
}

/**
 * LibreOffice / Web(Next.js) イメージを CodeBuild でビルドし ECR へ push するスタック。
 * ローカル Docker ビルドを回避する。
 */
export class EcrDeployStack extends cdk.Stack {
  public readonly libreOfficeImageTag: string;
  public readonly webImageTag: string;

  constructor(scope: Construct, id: string, props: EcrDeployStackProps) {
    super(scope, id, props);

    const projectName = props.projectName ?? 'quality-report';
    const buildTriggerPath = path.join(__dirname, '..', 'lambda', 'build-trigger');

    const onEvent = new lambda.Function(this, 'ImageBuildOnEventFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'on_event.handler',
      code: lambda.Code.fromAsset(buildTriggerPath),
      timeout: cdk.Duration.seconds(60),
    });
    const isComplete = new lambda.Function(this, 'ImageBuildIsCompleteFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'is_complete.handler',
      code: lambda.Code.fromAsset(buildTriggerPath),
      timeout: cdk.Duration.seconds(60),
    });
    const provider = new Provider(this, 'ImageBuildProvider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(90),
    });

    const libreOffice = this.createCodeBuildImageProject('LibreOffice', {
      projectName: `${projectName}-libreoffice-build`,
      sourcePath: path.join(__dirname, '..', 'lambda', 'libreoffice-convert'),
      repository: props.libreOfficeRepository,
      imageTag: LIBREOFFICE_IMAGE_TAG,
      arm64: true,
    });
    const libreTrigger = new cdk.CustomResource(this, 'LibreOfficeImageBuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: libreOffice.project.projectName,
        BuildContextHash: libreOffice.contextHash,
      },
    });
    libreTrigger.node.addDependency(libreOffice.project);
    libreTrigger.node.addDependency(libreOffice.sourceAsset);

    const web = this.createCodeBuildImageProject('Web', {
      projectName: `${projectName}-web-build`,
      sourcePath: path.join(__dirname, '..', 'containers', 'web'),
      repository: props.webRepository,
      imageTag: WEB_IMAGE_TAG,
      // node_modules / .next はコンテナ内でビルドするためアセットから除外する
      exclude: ['node_modules', '.next', '.git', '.env*.local'],
      arm64: true,
    });
    const webTrigger = new cdk.CustomResource(this, 'WebImageBuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: web.project.projectName,
        BuildContextHash: web.contextHash,
      },
    });
    webTrigger.node.addDependency(web.project);
    webTrigger.node.addDependency(web.sourceAsset);

    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [libreOffice.project.projectArn, web.project.projectArn],
      }),
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:BatchGetBuilds'],
        resources: [libreOffice.project.projectArn, web.project.projectArn],
      }),
    );

    this.libreOfficeImageTag = LIBREOFFICE_IMAGE_TAG;
    this.webImageTag = WEB_IMAGE_TAG;

    new cdk.CfnOutput(this, 'LibreOfficeImageUri', {
      value: `${props.libreOfficeRepository.repositoryUri}:${this.libreOfficeImageTag}`,
      description: 'LibreOffice image URI in ECR',
    });
    new cdk.CfnOutput(this, 'WebImageUri', {
      value: `${props.webRepository.repositoryUri}:${this.webImageTag}`,
      description: 'Web (Next.js) image URI in ECR',
    });
  }

  private createCodeBuildImageProject(
    id: string,
    options: {
      readonly projectName: string;
      readonly sourcePath: string;
      readonly repository: ecr.IRepository;
      readonly imageTag: string;
      readonly exclude?: string[];
      readonly arm64?: boolean;
    },
  ): {
    readonly project: codebuild.Project;
    readonly sourceAsset: Asset;
    readonly contextHash: string;
  } {
    const sourceAsset = new Asset(this, `${id}BuildContext`, {
      path: options.sourcePath,
      exclude: options.exclude,
    });
    const contextHash = crypto
      .createHash('md5')
      .update(sourceAsset.assetHash)
      .digest('hex')
      .substring(0, 8);

    const dockerPlatformFlag = options.arm64 ? '--platform linux/arm64 ' : '';
    const project = new codebuild.Project(this, `${id}BuildProject`, {
      projectName: options.projectName,
      environment: {
        buildImage: options.arm64
          ? codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0
          : codebuild.LinuxBuildImage.STANDARD_7_0,
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
        IMAGE_ECR_URI: { value: options.repository.repositoryUri },
        IMAGE_TAG: { value: options.imageTag },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com"',
            ],
          },
          build: {
            commands: [
              'echo Building container image...',
              `docker build ${dockerPlatformFlag}-t "$IMAGE_ECR_URI:$IMAGE_TAG" .`,
            ],
          },
          post_build: {
            commands: [
              'echo Pushing container image...',
              'docker push "$IMAGE_ECR_URI:$IMAGE_TAG"',
              'echo Docker build completed successfully',
            ],
          },
        },
      }),
    });
    options.repository.grantPullPush(project);
    sourceAsset.grantRead(project);
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    return { project, sourceAsset, contextHash };
  }
}
