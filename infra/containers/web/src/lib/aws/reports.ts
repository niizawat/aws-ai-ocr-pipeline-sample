import 'server-only';

import { ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { awsClients } from '@/lib/aws/clients';
import { env } from '@/lib/env';
import type { ReportItem, ReportListRow } from '@/lib/types';

/** DynamoDB テーブルを全件スキャンして全アイテムを返す（ページネーション込み）。 */
export async function scanAllItems(
  projection?: string,
): Promise<ReportItem[]> {
  const table = env.dynamoTable();
  const items: ReportItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await awsClients.dynamo.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: projection,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as ReportItem[]));
    exclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return items;
}

/** レポート一覧（report_id ごとに重複排除した代表行）を返す。 */
export async function listReports(): Promise<ReportListRow[]> {
  const items = await scanAllItems(
    'report_id, source_file, source_type, extracted_at, review_status, confidence_score',
  );

  const byId = new Map<string, ReportListRow>();
  for (const item of items) {
    if (!item.report_id || byId.has(item.report_id)) continue;
    byId.set(item.report_id, {
      report_id: item.report_id,
      source_file: item.source_file ?? '',
      source_type: item.source_type ?? '',
      extracted_at: item.extracted_at ?? '',
      review_status: item.review_status ?? '',
      confidence_score: item.confidence_score ?? '',
    });
  }
  return [...byId.values()];
}

/** 単一レポートの全セクションを取得する。 */
export async function getReportSections(reportId: string): Promise<ReportItem[]> {
  const res = await awsClients.dynamo.send(
    new QueryCommand({
      TableName: env.dynamoTable(),
      KeyConditionExpression: 'report_id = :rid',
      ExpressionAttributeValues: { ':rid': reportId },
    }),
  );
  return (res.Items ?? []) as ReportItem[];
}

/** status-index GSI で review_status により絞り込む。 */
export async function queryByStatus(status: string): Promise<ReportItem[]> {
  const res = await awsClients.dynamo.send(
    new QueryCommand({
      TableName: env.dynamoTable(),
      IndexName: 'status-index',
      KeyConditionExpression: 'review_status = :s',
      ExpressionAttributeValues: { ':s': status },
    }),
  );
  return (res.Items ?? []) as ReportItem[];
}
