'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import CloudUploadIcon from '@mui/icons-material/CloudUploadRounded';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFileRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorIcon from '@mui/icons-material/ErrorRounded';
import DeleteIcon from '@mui/icons-material/DeleteOutlineRounded';

import PageHeader from '@/components/PageHeader';
import { apiFetch } from '@/lib/fetcher';
import type { PresignedUpload } from '@/lib/types';

interface UploadResult {
  name: string;
  key: string;
  success: boolean;
  error?: string;
}

const ACCEPT = '.xlsx,.pdf';

function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function UploadPage() {
  const [files, setFiles] = React.useState<File[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [results, setResults] = React.useState<UploadResult[]>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const valid = Array.from(incoming).filter((f) =>
      /\.(xlsx|pdf)$/i.test(f.name),
    );
    setFiles((prev) => [...prev, ...valid]);
    setResults([]);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setProgress(0);
    setResults([]);

    try {
      const { uploads } = await apiFetch<{ uploads: PresignedUpload[] }>(
        '/api/uploads/presign',
        {
          method: 'POST',
          body: JSON.stringify({
            files: files.map((f) => ({ name: f.name, contentType: f.type })),
          }),
        },
      );

      const collected: UploadResult[] = [];
      for (let i = 0; i < uploads.length; i += 1) {
        const target = uploads[i];
        const file = files.find((f) => f.name === target.name);
        try {
          if (!file) throw new Error('対象ファイルが見つかりません。');
          const res = await fetch(target.url, {
            method: 'PUT',
            headers: { 'Content-Type': target.contentType },
            body: file,
          });
          if (!res.ok) throw new Error(`S3 への PUT に失敗しました (${res.status})`);
          collected.push({ name: target.name, key: target.key, success: true });
        } catch (e) {
          collected.push({
            name: target.name,
            key: target.key,
            success: false,
            error: e instanceof Error ? e.message : '不明なエラー',
          });
        }
        setProgress(((i + 1) / uploads.length) * 100);
      }
      setResults(collected);
      setFiles([]);
    } catch (e) {
      setResults([
        {
          name: '(presigned URL 取得)',
          key: '',
          success: false,
          error: e instanceof Error ? e.message : '不明なエラー',
        },
      ]);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box>
      <PageHeader
        title="レポートアップロード"
        description="品質レポート（Excel / PDF）をアップロードし、OCR 解析パイプラインに投入します。"
      />

      <Stack spacing={3}>
        <Card>
          <CardContent>
            <Box
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => inputRef.current?.click()}
              sx={{
                border: (t) =>
                  `2px dashed ${dragging ? t.palette.primary.main : t.palette.divider}`,
                borderRadius: 3,
                p: { xs: 4, md: 6 },
                textAlign: 'center',
                cursor: 'pointer',
                bgcolor: dragging ? 'action.hover' : 'transparent',
                transition: 'border-color .2s, background-color .2s',
              }}
            >
              <CloudUploadIcon sx={{ fontSize: 56, color: 'primary.main', mb: 1 }} />
              <Typography variant="subtitle1">
                ファイルをドラッグ＆ドロップ
              </Typography>
              <Typography variant="body2" color="text.secondary">
                または クリックして選択（.xlsx / .pdf、複数可）
              </Typography>
              <input
                ref={inputRef}
                type="file"
                hidden
                multiple
                accept={ACCEPT}
                onChange={(e) => addFiles(e.target.files)}
              />
            </Box>

            {files.length > 0 && (
              <>
                <List sx={{ mt: 2 }}>
                  {files.map((file, idx) => (
                    <ListItem
                      key={`${file.name}-${idx}`}
                      secondaryAction={
                        <IconButton
                          edge="end"
                          onClick={() => removeFile(idx)}
                          disabled={uploading}
                          aria-label="削除"
                        >
                          <DeleteIcon />
                        </IconButton>
                      }
                    >
                      <ListItemIcon>
                        <InsertDriveFileIcon color="action" />
                      </ListItemIcon>
                      <ListItemText primary={file.name} secondary={formatSize(file.size)} />
                    </ListItem>
                  ))}
                </List>

                {uploading && (
                  <LinearProgress
                    variant="determinate"
                    value={progress}
                    sx={{ my: 2, borderRadius: 1 }}
                  />
                )}

                <Stack direction="row" spacing={1} sx={{ mt: 1, justifyContent: 'flex-end' }}>
                  <Button
                    onClick={() => setFiles([])}
                    disabled={uploading}
                    color="inherit"
                  >
                    クリア
                  </Button>
                  <Button
                    variant="contained"
                    startIcon={<CloudUploadIcon />}
                    onClick={() => void handleUpload()}
                    disabled={uploading}
                  >
                    アップロード実行
                  </Button>
                </Stack>
              </>
            )}
          </CardContent>
        </Card>

        {results.length > 0 && (
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ mb: 1 }}>
                アップロード結果
              </Typography>
              <Stack spacing={1}>
                {results.map((r, idx) => (
                  <Alert
                    key={idx}
                    severity={r.success ? 'success' : 'error'}
                    variant="outlined"
                    icon={r.success ? <CheckCircleIcon /> : <ErrorIcon />}
                  >
                    {r.success
                      ? `${r.name} → ${r.key}`
                      : `${r.name}: ${r.error ?? '不明なエラー'}`}
                  </Alert>
                ))}
              </Stack>
            </CardContent>
          </Card>
        )}
      </Stack>
    </Box>
  );
}
