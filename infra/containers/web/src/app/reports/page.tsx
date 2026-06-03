'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Link from '@mui/material/Link';
import ExpandMoreIcon from '@mui/icons-material/ExpandMoreRounded';
import DownloadIcon from '@mui/icons-material/DownloadRounded';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';

import PageHeader from '@/components/PageHeader';
import { LoadingView, ErrorView, EmptyView } from '@/components/StateViews';
import OcrPreview from '@/components/ocr/OcrPreview';
import { apiFetch } from '@/lib/fetcher';
import type { ReportListRow, ReportItem, OcrPreview as OcrPreviewData } from '@/lib/types';

const columns: GridColDef<ReportListRow>[] = [
  { field: 'report_id', headerName: 'レポート ID', flex: 1.4, minWidth: 180 },
  { field: 'source_file', headerName: '元ファイル', flex: 1.6, minWidth: 200 },
  { field: 'source_type', headerName: '種別', width: 100 },
  {
    field: 'review_status',
    headerName: 'ステータス',
    width: 140,
    renderCell: (params) => (
      <Chip
        size="small"
        label={params.value || '-'}
        color={params.value === 'completed' ? 'success' : 'default'}
        variant="outlined"
      />
    ),
  },
  { field: 'confidence_score', headerName: '信頼度', width: 110 },
  { field: 'extracted_at', headerName: '抽出日時', flex: 1.2, minWidth: 180 },
];

export default function ReportsPage() {
  const [rows, setRows] = React.useState<ReportListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const { reports } = await apiFetch<{ reports: ReportListRow[] }>('/api/reports');
        setRows(reports);
      } catch (e) {
        setError(e instanceof Error ? e.message : '取得に失敗しました。');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Box>
      <PageHeader
        title="レポート閲覧"
        description="アップロード済みレポートの元ファイルと AI 抽出結果を並べて確認します。"
      />

      {loading && <LoadingView />}
      {error && <ErrorView message={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyView message="レポートがまだ登録されていません。" />
      )}

      {!loading && !error && rows.length > 0 && (
        <Stack spacing={3}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ mb: 2 }}>
                レポート一覧
              </Typography>
              <DataGrid
                rows={rows}
                columns={columns}
                getRowId={(r) => r.report_id}
                onRowClick={(params) => setSelectedId(String(params.id))}
                disableRowSelectionOnClick={false}
                initialState={{
                  pagination: { paginationModel: { pageSize: 10 } },
                }}
                pageSizeOptions={[10, 25, 50]}
                sx={{ border: 0, cursor: 'pointer' }}
                autoHeight
              />
            </CardContent>
          </Card>

          {selectedId ? (
            <ReportDetail reportId={selectedId} />
          ) : (
            <EmptyView message="レポートを選択してください。" />
          )}
        </Stack>
      )}
    </Box>
  );
}

interface DownloadInfo {
  url: string;
  sourceType: string;
}

interface ImageInfo {
  key: string;
  name: string;
  url: string;
}

function ReportDetail({ reportId }: { reportId: string }) {
  const [sections, setSections] = React.useState<ReportItem[]>([]);
  const [download, setDownload] = React.useState<DownloadInfo | null>(null);
  const [images, setImages] = React.useState<ImageInfo[]>([]);
  const [ocr, setOcr] = React.useState<OcrPreviewData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setDownload(null);
    setImages([]);
    setOcr(null);

    void (async () => {
      try {
        const detail = await apiFetch<{ sections: ReportItem[] }>(
          `/api/reports/${encodeURIComponent(reportId)}`,
        );
        if (!active) return;
        setSections(detail.sections);

        const [dl, img, ocrRes] = await Promise.allSettled([
          apiFetch<DownloadInfo>(`/api/reports/${encodeURIComponent(reportId)}/download`),
          apiFetch<{ images: ImageInfo[] }>(
            `/api/reports/${encodeURIComponent(reportId)}/images`,
          ),
          apiFetch<OcrPreviewData>(`/api/reports/${encodeURIComponent(reportId)}/ocr`),
        ]);
        if (!active) return;
        if (dl.status === 'fulfilled') setDownload(dl.value);
        if (img.status === 'fulfilled') setImages(img.value.images);
        if (ocrRes.status === 'fulfilled') setOcr(ocrRes.value);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '取得に失敗しました。');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [reportId]);

  const hasOcr = ocr?.available ?? false;

  return (
    <Card>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}
        >
          <Typography variant="h6">レポート詳細: {reportId}</Typography>
          {download && (
            <Button
              variant="outlined"
              size="small"
              startIcon={<DownloadIcon />}
              component={Link}
              href={download.url}
              target="_blank"
              rel="noopener"
            >
              {download.sourceType === 'pdf' ? 'PDF' : 'Excel'} をダウンロード
            </Button>
          )}
        </Stack>

        {loading && <LoadingView />}
        {error && <ErrorView message={error} />}

        {/* OCR の検出結果がある場合はレイヤー表示プレビューを優先する */}
        {!loading && !error && hasOcr && ocr && (
          <OcrPreview pages={ocr.pages} />
        )}

        {/* OCR データが無い場合（Excel / デジタル PDF 等）は従来の抽出結果表示 */}
        {!loading && !error && !hasOcr && (
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            }}
          >
            <Box>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                元ファイル
              </Typography>
              {images.length > 0 ? (
                <Stack spacing={1.5}>
                  {images.map((img) => (
                    <Box key={img.key}>
                      {/* presigned URL を直接表示するため next/image は使用しない */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {/* biome-ignore lint/performance/noImgElement: presigned S3 URL */}
                      <img
                        src={img.url}
                        alt={img.name}
                        style={{ width: '100%', borderRadius: 8, display: 'block' }}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {img.name}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  プレビュー画像がありません。
                </Typography>
              )}
            </Box>

            <Box>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                AI 抽出結果
              </Typography>
              {sections.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  抽出結果がありません。
                </Typography>
              ) : (
                sections.map((item) => {
                  const { report_id, page_section, ...rest } = item;
                  void report_id;
                  return (
                    <Accordion
                      key={page_section}
                      disableGutters
                      variant="outlined"
                    >
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          セクション: {page_section}（信頼度:{' '}
                          {String(item.confidence_score ?? 'N/A')}）
                        </Typography>
                      </AccordionSummary>
                      <AccordionDetails>
                        <Box
                          component="pre"
                          sx={{
                            m: 0,
                            p: 1.5,
                            borderRadius: 1,
                            bgcolor: 'background.default',
                            fontSize: '0.78rem',
                            overflowX: 'auto',
                            fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                          }}
                        >
                          {JSON.stringify(rest, null, 2)}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          ステータス: {String(item.review_status ?? 'N/A')}
                        </Typography>
                      </AccordionDetails>
                    </Accordion>
                  );
                })
              )}
            </Box>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
