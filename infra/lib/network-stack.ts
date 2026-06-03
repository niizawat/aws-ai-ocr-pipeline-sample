import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  readonly projectName?: string;
}

/**
 * ネットワーク基盤スタック
 * VPC、サブネット、セキュリティグループ、VPC エンドポイントを管理する
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly ecsGpuSg: ec2.ISecurityGroup;
  public readonly ecsFargateSg: ec2.ISecurityGroup;
  public readonly lambdaSg: ec2.ISecurityGroup;
  public readonly albSg: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props?: NetworkStackProps) {
    super(scope, id, props);

    const projectName = props?.projectName ?? 'quality-report';

    // VPC: 2 AZ 構成（PoC 用に最小限）
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${projectName}-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // VPC Flow Logs
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
      logGroupName: `/vpc/${projectName}/flow-logs`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    // セキュリティグループ: ALB
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-alb-sg`,
      description: 'Security group for Streamlit ALB',
      allowAllOutbound: false,
    });
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP from internet (HTTPS redirect)',
    );
    this.albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS from internet',
    );

    // セキュリティグループ: ECS GPU クラスタ（PaddleOCR-VL）
    this.ecsGpuSg = new ec2.SecurityGroup(this, 'EcsGpuSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-ecs-gpu-sg`,
      description: 'Security group for PaddleOCR-VL GPU containers',
      allowAllOutbound: true,
    });

    // セキュリティグループ: ECS Fargate（LibreOffice + Streamlit）
    this.ecsFargateSg = new ec2.SecurityGroup(this, 'EcsFargateSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-ecs-fargate-sg`,
      description: 'Security group for ECS Fargate services',
      allowAllOutbound: true,
    });

    // セキュリティグループ: Lambda
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: `${projectName}-lambda-sg`,
      description: 'Security group for VPC Lambda functions',
      allowAllOutbound: true,
    });

    // Lambda → ECS GPU (PaddleOCR-VL ポート 8080)
    this.ecsGpuSg.addIngressRule(
      this.lambdaSg,
      ec2.Port.tcp(8080),
      'OCR requests from Lambda',
    );

    // VPC Link / ALB → ECS Fargate (Next.js ポート 3000)
    this.ecsFargateSg.addIngressRule(
      this.albSg,
      ec2.Port.tcp(3000),
      'Web traffic from VPC Link',
    );
    this.albSg.addEgressRule(
      this.ecsFargateSg,
      ec2.Port.tcp(3000),
      'Forward to Next.js targets',
    );
    this.albSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Cognito OIDC endpoints',
    );

    // VPC Endpoints: Gateway 型（無料）
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // VPC Endpoints: Interface 型
    const interfaceEndpointSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    };

    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SqsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('StepFunctionsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    // Session Manager / ECS Exec（プライベートサブネット上の EC2・ECS 向け）
    this.vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: interfaceEndpointSubnets,
      privateDnsEnabled: true,
    });

    // -------------------------------------------------------
    // 段階的移行: AnalysisStack が以前参照していた Public Subnet エクスポートを維持
    // AnalysisStack デプロイ後にこれらの参照が解消されたら削除可能
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'LegacyPublicSubnet1', {
      value: this.vpc.publicSubnets[0].subnetId,
      exportName: `${cdk.Aws.STACK_NAME}:ExportsOutputRefVpcPublicSubnet1Subnet5C2D37C4FFA2B456`,
    });
    new cdk.CfnOutput(this, 'LegacyPublicSubnet2', {
      value: this.vpc.publicSubnets[1].subnetId,
      exportName: `${cdk.Aws.STACK_NAME}:ExportsOutputRefVpcPublicSubnet2Subnet691E08A351552740`,
    });
  }
}
