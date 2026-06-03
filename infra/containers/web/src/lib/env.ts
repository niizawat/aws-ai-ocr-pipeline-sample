import 'server-only';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`環境変数 ${name} が設定されていません。`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  region: optional('AWS_REGION', optional('AWS_DEFAULT_REGION', 'us-east-1')),
  dynamoTable: () => required('DYNAMODB_TABLE', 'quality-report-reports'),
  s3Bucket: () => required('S3_BUCKET'),
  vectorBucket: () => required('VECTOR_BUCKET'),
  vectorIndex: () => optional('VECTOR_INDEX', 'report-embeddings'),
  flowDefinitionArn: () => optional('FLOW_DEFINITION_ARN'),
  workteamName: () => optional('WORKTEAM_NAME'),
  embedModelId: () => optional('BEDROCK_EMBED_MODEL_ID', 'amazon.titan-embed-text-v2:0'),
  chatModelId: () =>
    optional('BEDROCK_CHAT_MODEL_ID', 'us.anthropic.claude-sonnet-4-6'),
  authEnabled: () => optional('AUTH_ENABLED', 'false').toLowerCase() === 'true',
};
