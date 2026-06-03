import 'server-only';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { SageMakerClient } from '@aws-sdk/client-sagemaker';
import { SageMakerA2IRuntimeClient } from '@aws-sdk/client-sagemaker-a2i-runtime';

import { env } from '@/lib/env';

const region = env.region;

/**
 * Next.js のホットリロードでクライアントが増殖しないよう globalThis にキャッシュする。
 * 認証情報は ECS タスクロール（本番）またはローカルの AWS プロファイルから解決される。
 */
const globalForAws = globalThis as unknown as {
  __awsClients?: {
    dynamo: DynamoDBDocumentClient;
    s3: S3Client;
    bedrock: BedrockRuntimeClient;
    s3vectors: S3VectorsClient;
    sagemakerA2i: SageMakerA2IRuntimeClient;
    sagemaker: SageMakerClient;
  };
};

function createClients() {
  const dynamoRaw = new DynamoDBClient({ region });
  return {
    dynamo: DynamoDBDocumentClient.from(dynamoRaw, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3: new S3Client({ region }),
    bedrock: new BedrockRuntimeClient({ region }),
    s3vectors: new S3VectorsClient({ region }),
    sagemakerA2i: new SageMakerA2IRuntimeClient({ region }),
    sagemaker: new SageMakerClient({ region }),
  };
}

export const awsClients = globalForAws.__awsClients ?? createClients();

if (process.env.NODE_ENV !== 'production') {
  globalForAws.__awsClients = awsClients;
}
