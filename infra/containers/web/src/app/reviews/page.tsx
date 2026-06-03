'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';

import PageHeader from '@/components/PageHeader';
import { LoadingView, ErrorView, EmptyView } from '@/components/StateViews';
import { apiFetch } from '@/lib/fetcher';
import type { ReportItem, HumanLoopSummary } from '@/lib/types';

const PENDING_SECTION = '_a2i_pending';

function sectionLabel(item: ReportItem): string {
  if (item.page_section === PENDING_SECTION) {
    const text = String(item.content_text ?? '').trim();
    return text || '（レビュー待ち）';
  }
  return String(item.page_section ?? '');
}

function buildReviewColumns(
  portalUrl: string,
  showOpenAction: boolean,
): GridColDef<ReportItem & { _rid: string }>[] {
  const cols: GridColDef<ReportItem & { _rid: string }>[] = [
    { field: 'report_id', headerName: 'レポート ID', flex: 1.4, minWidth: 180 },
    {
      field: 'page_section',
      headerName: 'セクション',
      flex: 1,
      minWidth: 140,
      valueGetter: (_, row) => sectionLabel(row),
    },
    { field: 'source_file', headerName: '元ファイル', flex: 1.4, minWidth: 180 },
    { field: 'confidence_score', headerName: '信頼度', width: 110 },
    { field: 'extracted_at', headerName: '登録日時', flex: 1.2, minWidth: 180 },
  ];

  if (showOpenAction && portalUrl) {
    cols.push({
      field: '_actions',
      headerName: '操作',
      width: 220,
      sortable: false,
      filterable: false,
      renderCell: () => (
        <Button
          size="small"
          variant="contained"
          endIcon={<OpenInNewIcon />}
          href={portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          component="a"
        >
          ポータルでレビュー
        </Button>
      ),
    });
  }

  return cols;
}

const loopColumns: GridColDef<HumanLoopSummary & { id: string }>[] = [
  { field: 'name', headerName: 'Loop 名', flex: 1.6, minWidth: 220 },
  {
    field: 'status',
    headerName: 'ステータス',
    width: 160,
    renderCell: (params) => (
      <Chip size="small" variant="outlined" label={params.value || '-'} />
    ),
  },
  { field: 'creationTime', headerName: '作成日時', flex: 1.2, minWidth: 200 },
];

export default function ReviewsPage() {
  const [tab, setTab] = React.useState(0);
  const status = tab === 0 ? 'pending_review' : 'reviewed';

  return (
    <Box>
      <PageHeader
        title="レビュー管理"
        description="A2I Human Review の状況を確認します。実際のレビュー作業は SageMaker Private Workforce のラベリングポータルで行います。"
      />

      <LabelingPortalBanner />

      <Card sx={{ mb: 3 }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{ px: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
        >
          <Tab label="レビュー待ち" />
          <Tab label="人間レビュー完了" />
        </Tabs>
        <CardContent>
          <ReviewTable status={status} key={status} />
        </CardContent>
      </Card>

      <HumanLoopPanel />
    </Box>
  );
}

function LabelingPortalBanner() {
  const [portalUrl, setPortalUrl] = React.useState('');
  const [configured, setConfigured] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<{
          configured: boolean;
          url: string;
          workteamName: string;
        }>('/api/reviews/labeling-portal');
        setConfigured(res.configured);
        setPortalUrl(res.url);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'ポータル URL の取得に失敗しました。');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return null;

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="subtitle1">SageMaker ラベリングポータル（Private Workforce）</Typography>
          <Typography variant="body2" color="text.secondary">
            低信頼度レポートの承認・修正は、本アプリではなく AWS のラベリングポータルで実施します。
            作業者は Workforce 用 Cognito（quality-reviewers グループ）のアカウントでサインインしてください。
            Web アプリの Cognito とは別のユーザープールです。
          </Typography>
          {error && <ErrorView message={error} />}
          {!error && !configured && (
            <Alert severity="warning">
              WORKTEAM_NAME が未設定のため、ラベリングポータル URL を取得できません。
            </Alert>
          )}
          {!error && configured && portalUrl && (
            <Button
              variant="contained"
              size="large"
              endIcon={<OpenInNewIcon />}
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              component="a"
              sx={{ alignSelf: 'flex-start' }}
            >
              ラベリングポータルを開く
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function ReviewTable({ status }: { status: string }) {
  const [items, setItems] = React.useState<ReportItem[]>([]);
  const [portalUrl, setPortalUrl] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const isPending = status === 'pending_review';

  React.useEffect(() => {
    void (async () => {
      try {
        const [listRes, portalRes] = await Promise.all([
          apiFetch<{ items: ReportItem[] }>(`/api/reviews?status=${status}`),
          isPending
            ? apiFetch<{ configured: boolean; url: string }>(
                '/api/reviews/labeling-portal',
              )
            : Promise.resolve({ configured: false, url: '' }),
        ]);
        setItems(listRes.items);
        if (portalRes.configured) setPortalUrl(portalRes.url);
      } catch (e) {
        setError(e instanceof Error ? e.message : '取得に失敗しました。');
      } finally {
        setLoading(false);
      }
    })();
  }, [status, isPending]);

  if (loading) return <LoadingView />;
  if (error) return <ErrorView message={error} />;
  if (items.length === 0) {
    return (
      <EmptyView
        message={
          isPending
            ? 'レビュー待ちのレポートはありません。'
            : '人間レビュー完了のレポートはありません。'
        }
      />
    );
  }

  const rows = items.map((item, idx) => ({ ...item, _rid: `${item.report_id}-${idx}` }));
  const columns = buildReviewColumns(portalUrl, isPending);

  return (
    <Box>
      {isPending && !portalUrl && (
        <Alert severity="info" sx={{ mb: 2 }}>
          ラベリングポータル URL を取得できませんでした。下部の A2I Human Loop 一覧で進捗を確認してください。
        </Alert>
      )}
      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(r) => r._rid}
        initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
        pageSizeOptions={[10, 25, 50]}
        sx={{ border: 0 }}
        autoHeight
        disableRowSelectionOnClick
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        合計: {items.length} 件
        {isPending && portalUrl
          ? ' — 「ポータルでレビュー」から SageMaker Private Workforce を開いて作業してください。'
          : ''}
      </Typography>
    </Box>
  );
}

function HumanLoopPanel() {
  const [loops, setLoops] = React.useState<HumanLoopSummary[]>([]);
  const [configured, setConfigured] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<{ configured: boolean; loops: HumanLoopSummary[] }>(
          '/api/reviews/human-loops',
        );
        setConfigured(res.configured);
        setLoops(res.loops);
      } catch (e) {
        setError(e instanceof Error ? e.message : '取得に失敗しました。');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" sx={{ mb: 2 }}>
          A2I Human Loop 一覧（参考）
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          SageMaker 側の Human Loop 状態です。レビュー作業自体は上記ラベリングポータルで行います。
        </Typography>
        {loading && <LoadingView />}
        {!loading && error && <ErrorView message={error} />}
        {!loading && !error && !configured && (
          <EmptyView message="FLOW_DEFINITION_ARN が設定されていません。" />
        )}
        {!loading && !error && configured && loops.length === 0 && (
          <EmptyView message="アクティブな Human Loop はありません。" />
        )}
        {!loading && !error && configured && loops.length > 0 && (
          <DataGrid
            rows={loops.map((l, i) => ({ ...l, id: `${l.name}-${i}` }))}
            columns={loopColumns}
            initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
            pageSizeOptions={[10, 20]}
            sx={{ border: 0 }}
            autoHeight
            disableRowSelectionOnClick
          />
        )}
      </CardContent>
    </Card>
  );
}
