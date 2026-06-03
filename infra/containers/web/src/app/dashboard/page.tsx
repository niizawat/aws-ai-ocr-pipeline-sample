'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import IconButton from '@mui/material/IconButton';
import RefreshIcon from '@mui/icons-material/RefreshRounded';
import DescriptionIcon from '@mui/icons-material/DescriptionRounded';
import TaskAltIcon from '@mui/icons-material/TaskAltRounded';
import PendingIcon from '@mui/icons-material/HourglassTopRounded';
import VerifiedIcon from '@mui/icons-material/VerifiedRounded';

import PageHeader from '@/components/PageHeader';
import { LoadingView, ErrorView, EmptyView } from '@/components/StateViews';
import {
  MonthlyChart,
  StatusDonut,
  ParetoChart,
} from '@/components/charts/DashboardCharts';
import { apiFetch } from '@/lib/fetcher';
import type { DashboardMetrics } from '@/lib/types';

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, icon, color }: StatCardProps) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Avatar variant="rounded" sx={{ bgcolor: `${color}1f`, color, width: 48, height: 48 }}>
            {icon}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" color="text.secondary" noWrap>
              {label}
            </Typography>
            <Typography variant="h5">{value}</Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ mb: 2 }}>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [data, setData] = React.useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<DashboardMetrics>('/api/dashboard/metrics');
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <Box>
      <PageHeader
        title="ダッシュボード"
        description="品質レポートの登録状況とOCR処理の全体像を可視化します。"
        actions={
          <IconButton onClick={() => void load()} aria-label="再読み込み">
            <RefreshIcon />
          </IconButton>
        }
      />

      {loading && <LoadingView />}
      {error && <ErrorView message={error} />}

      {!loading && !error && data && !data.hasData && (
        <EmptyView message="レポートデータがまだ登録されていません。" />
      )}

      {!loading && !error && data && data.hasData && (
        <Stack spacing={3}>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: {
                xs: '1fr',
                sm: '1fr 1fr',
                lg: 'repeat(4, 1fr)',
              },
            }}
          >
            <StatCard
              label="総レポート数"
              value={String(data.totalReports)}
              icon={<DescriptionIcon />}
              color="#0f766e"
            />
            <StatCard
              label="対策完了率"
              value={`${data.completionRate.toFixed(1)}%`}
              icon={<TaskAltIcon />}
              color="#15803d"
            />
            <StatCard
              label="レビュー待ち"
              value={String(data.pendingReview)}
              icon={<PendingIcon />}
              color="#b45309"
            />
            <StatCard
              label="平均信頼度"
              value={data.avgConfidence.toFixed(2)}
              icon={<VerifiedIcon />}
              color="#0369a1"
            />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <ChartCard title="不具合件数推移（月別）">
              {data.monthly.length > 0 ? (
                <MonthlyChart data={data.monthly} />
              ) : (
                <EmptyView message="日付データが不足しています。" />
              )}
            </ChartCard>
            <ChartCard title="不具合分類（パレート）">
              {data.defectPareto.length > 0 ? (
                <ParetoChart data={data.defectPareto} />
              ) : (
                <EmptyView message="不具合分類データが不足しています。" />
              )}
            </ChartCard>
          </Box>

          <ChartCard title="OCR 処理ステータス">
            {data.statusBreakdown.length > 0 ? (
              <Box sx={{ maxWidth: 480, mx: 'auto' }}>
                <StatusDonut data={data.statusBreakdown} />
              </Box>
            ) : (
              <EmptyView message="ステータスデータが不足しています。" />
            )}
          </ChartCard>
        </Stack>
      )}
    </Box>
  );
}
