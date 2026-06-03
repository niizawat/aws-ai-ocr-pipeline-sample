import 'server-only';

import { scanAllItems } from '@/lib/aws/reports';
import type { DashboardMetrics, ReportItem } from '@/lib/types';

function monthOf(extractedAt?: string): string | null {
  if (!extractedAt) return null;
  const d = new Date(extractedAt);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Streamlit ダッシュボードの集計ロジックを踏襲する。
 * - KPI: 総レポート数 / 対策完了率 / レビュー待ち / 平均信頼度
 * - 月別件数 / 不具合分類パレート / ステータス内訳
 */
export async function computeDashboardMetrics(): Promise<DashboardMetrics> {
  const items = await scanAllItems();

  if (items.length === 0) {
    return {
      hasData: false,
      totalReports: 0,
      completionRate: 0,
      pendingReview: 0,
      avgConfidence: 0,
      monthly: [],
      defectPareto: [],
      statusBreakdown: [],
    };
  }

  const uniqueIds = new Set(items.map((i) => i.report_id).filter(Boolean));

  const completed = items.filter((i) => i.review_status === 'completed').length;
  const pendingReview = items.filter(
    (i) => i.review_status === 'pending_review',
  ).length;
  const completionRate = items.length > 0 ? (completed / items.length) * 100 : 0;

  const confidenceValues = items
    .map((i) => Number(i.confidence_score))
    .filter((n) => !Number.isNaN(n));
  const avgConfidence =
    confidenceValues.length > 0
      ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
      : 0;

  // 月別件数
  const monthCounts = new Map<string, number>();
  for (const i of items) {
    const m = monthOf(i.extracted_at);
    if (!m) continue;
    monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
  }
  const monthly = [...monthCounts.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // 不具合分類パレート（defect_type が存在する場合のみ）
  const defectPareto = buildPareto(items);

  // ステータス内訳
  const statusCounts = new Map<string, number>();
  for (const i of items) {
    const s = i.review_status ?? 'unknown';
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  const statusBreakdown = [...statusCounts.entries()].map(([status, count]) => ({
    status,
    count,
  }));

  return {
    hasData: true,
    totalReports: uniqueIds.size,
    completionRate,
    pendingReview,
    avgConfidence,
    monthly,
    defectPareto,
    statusBreakdown,
  };
}

function buildPareto(items: ReportItem[]): DashboardMetrics['defectPareto'] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const defect = i.defect_type;
    if (typeof defect !== 'string' || defect === '') continue;
    counts.set(defect, (counts.get(defect) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([defectType, count]) => ({ defectType, count }))
    .sort((a, b) => b.count - a.count);

  const total = sorted.reduce((acc, d) => acc + d.count, 0);
  let cumulative = 0;
  return sorted.map((d) => {
    cumulative += d.count;
    return {
      ...d,
      cumulativePct: total > 0 ? (cumulative / total) * 100 : 0,
    };
  });
}
