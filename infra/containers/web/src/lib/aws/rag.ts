import 'server-only';

import {
  InvokeModelCommand,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { QueryVectorsCommand } from '@aws-sdk/client-s3vectors';

import { awsClients } from '@/lib/aws/clients';
import { env } from '@/lib/env';
import type { RagAnswer, RagReference } from '@/lib/types';

const SYSTEM_PREFIX =
  'あなたは製造業の品質管理の専門家です。' +
  '以下の品質レポートデータに基づいて質問に回答してください。' +
  'データに含まれない情報については「データに含まれていません」と回答してください。';

/** クエリを Titan Embeddings V2 でベクトル化する。 */
async function embedQuery(query: string): Promise<number[]> {
  const res = await awsClients.bedrock.send(
    new InvokeModelCommand({
      modelId: env.embedModelId(),
      body: JSON.stringify({ inputText: query }),
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  return decoded.embedding as number[];
}

/**
 * RAG 検索: Titan Embed -> S3 Vectors query(topK=10) -> Bedrock Converse(Claude)。
 * Streamlit の 2_rag_search.py と同じ振る舞い。
 */
export async function ragQuery(query: string): Promise<RagAnswer> {
  const queryVector = await embedQuery(query);

  const search = await awsClients.s3vectors.send(
    new QueryVectorsCommand({
      vectorBucketName: env.vectorBucket(),
      indexName: env.vectorIndex(),
      queryVector: { float32: queryVector },
      topK: 10,
      returnMetadata: true,
    }),
  );

  const vectors = search.vectors ?? [];
  if (vectors.length === 0) {
    return {
      answer: '関連するレポートが見つかりませんでした。',
      references: [],
      found: false,
    };
  }

  const contextParts: string[] = [];
  const references: RagReference[] = [];
  for (const v of vectors) {
    const meta = (v.metadata ?? {}) as Record<string, unknown>;
    const content = typeof meta.content_text === 'string' ? meta.content_text : '';
    if (content) contextParts.push(content);
    references.push({
      reportId: typeof meta.report_id === 'string' ? meta.report_id : '不明',
      reportDate: typeof meta.report_date === 'string' ? meta.report_date : '',
    });
  }

  const context = contextParts.join('\n---\n');

  const answerResp = await awsClients.bedrock.send(
    new ConverseCommand({
      modelId: env.chatModelId(),
      messages: [
        {
          role: 'user',
          content: [
            {
              text: `${SYSTEM_PREFIX}\n\n## 参照データ\n${context}\n\n## 質問\n${query}`,
            },
          ],
        },
      ],
    }),
  );

  const answer =
    answerResp.output?.message?.content?.[0]?.text ?? '回答を生成できませんでした。';

  const uniqueRefs = dedupeReferences(references).slice(0, 5);

  return { answer, references: uniqueRefs, found: true };
}

function dedupeReferences(refs: RagReference[]): RagReference[] {
  const seen = new Set<string>();
  const result: RagReference[] = [];
  for (const r of refs) {
    const key = `${r.reportId}|${r.reportDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}
