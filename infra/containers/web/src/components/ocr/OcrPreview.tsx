'use client';

import * as React from 'react';
import DOMPurify from 'dompurify';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import ZoomInIcon from '@mui/icons-material/ZoomInRounded';
import ZoomOutIcon from '@mui/icons-material/ZoomOutRounded';
import FitScreenIcon from '@mui/icons-material/FitScreenRounded';
import LayersIcon from '@mui/icons-material/LayersRounded';

import type { OcrPreviewPage, OcrPreviewBlock } from '@/lib/types';
import { blockColor, blockLabelJa, isVisualLabel } from '@/components/ocr/blockColors';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

function sanitize(html: string): string {
  if (typeof window === 'undefined') return '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export default function OcrPreview({ pages }: { pages: OcrPreviewPage[] }) {
  const [pageIndex, setPageIndex] = React.useState(0);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<OcrPreviewBlock | null>(null);
  const [showOverlay, setShowOverlay] = React.useState(true);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });

  const page = pages[Math.min(pageIndex, pages.length - 1)];

  const resetView = React.useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ページ切替時に表示をリセットする
  React.useEffect(() => {
    resetView();
    setHoveredId(null);
  }, [pageIndex, resetView]);

  return (
    <Box>
      {pages.length > 1 && (
        <ToggleButtonGroup
          size="small"
          exclusive
          value={pageIndex}
          onChange={(_, v) => v !== null && setPageIndex(v)}
          sx={{ mb: 2, flexWrap: 'wrap' }}
        >
          {pages.map((p, i) => (
            <ToggleButton key={p.page} value={i}>
              ページ {p.page}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' },
          alignItems: 'start',
        }}
      >
        <ImagePanel
          page={page}
          showOverlay={showOverlay}
          setShowOverlay={setShowOverlay}
          hoveredId={hoveredId}
          setHoveredId={setHoveredId}
          zoom={zoom}
          setZoom={setZoom}
          pan={pan}
          setPan={setPan}
          resetView={resetView}
          onSelect={setSelected}
        />
        <BlocksPanel
          page={page}
          hoveredId={hoveredId}
          setHoveredId={setHoveredId}
          onSelect={setSelected}
        />
      </Box>

      <BlockDetailDialog block={selected} onClose={() => setSelected(null)} />
    </Box>
  );
}

interface ImagePanelProps {
  page: OcrPreviewPage;
  showOverlay: boolean;
  setShowOverlay: (v: boolean) => void;
  hoveredId: string | null;
  setHoveredId: (v: string | null) => void;
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  pan: { x: number; y: number };
  setPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  resetView: () => void;
  onSelect: (b: OcrPreviewBlock) => void;
}

function ImagePanel({
  page,
  showOverlay,
  setShowOverlay,
  hoveredId,
  setHoveredId,
  zoom,
  setZoom,
  pan,
  setPan,
  resetView,
  onSelect,
}: ImagePanelProps) {
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [size, setSize] = React.useState({
    clientW: 0,
    clientH: 0,
    naturalW: 0,
    naturalH: 0,
  });
  const dragRef = React.useRef<{ x: number; y: number } | null>(null);

  const measure = React.useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setSize({
      clientW: img.clientWidth,
      clientH: img.clientHeight,
      naturalW: img.naturalWidth,
      naturalH: img.naturalHeight,
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 画像変更時に再計測する
  React.useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(img);
    return () => ro.disconnect();
  }, [measure, page.imageUrl]);

  const refW = page.width ?? size.naturalW;
  const refH = page.height ?? size.naturalH;
  const scaleX = refW > 0 ? size.clientW / refW : 0;
  const scaleY = refH > 0 ? size.clientH / refH : 0;

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => clamp(z - Math.sign(e.deltaY) * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
  };

  return (
    <Card sx={{ overflow: 'hidden' }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          p: 1,
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: (t) => `1px solid ${t.palette.divider}`,
        }}
      >
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
          }
          label={
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <LayersIcon fontSize="small" />
              <Typography variant="body2">オーバーレイ</Typography>
            </Stack>
          }
        />
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Tooltip title="縮小">
            <IconButton
              size="small"
              onClick={() => setZoom((z) => clamp(z - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
            >
              <ZoomOutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Typography variant="caption" sx={{ width: 44, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </Typography>
          <Tooltip title="拡大">
            <IconButton
              size="small"
              onClick={() => setZoom((z) => clamp(z + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
            >
              <ZoomInIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="全体表示">
            <IconButton size="small" onClick={resetView}>
              <FitScreenIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      <Box
        onWheel={onWheel}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current) return;
          setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
        sx={{
          position: 'relative',
          height: { xs: 420, md: 600 },
          overflow: 'hidden',
          bgcolor: 'background.default',
          display: 'grid',
          placeItems: 'center',
          cursor: zoom > 1 ? 'grab' : 'default',
        }}
      >
        {page.imageUrl ? (
          <Box
            sx={{
              position: 'relative',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: dragRef.current ? 'none' : 'transform .15s ease',
              transformOrigin: 'center center',
            }}
          >
            {/* OCR が処理した画像（presigned URL）。bbox はこの画像座標へスケールする */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* biome-ignore lint/performance/noImgElement: presigned S3 URL */}
            <img
              ref={imgRef}
              src={page.imageUrl}
              alt={`page-${page.page}`}
              onLoad={measure}
              draggable={false}
              style={{
                display: 'block',
                maxWidth: '100%',
                maxHeight: 580,
                width: 'auto',
                height: 'auto',
                userSelect: 'none',
              }}
            />
            {showOverlay &&
              scaleX > 0 &&
              page.blocks.map((block) => {
                if (!block.bbox) return null;
                const [x1, y1, x2, y2] = block.bbox;
                const color = blockColor(block.label);
                const active = hoveredId === block.id;
                return (
                  <Box
                    key={block.id}
                    onMouseEnter={() => setHoveredId(block.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => onSelect(block)}
                    sx={{
                      position: 'absolute',
                      left: x1 * scaleX,
                      top: y1 * scaleY,
                      width: (x2 - x1) * scaleX,
                      height: (y2 - y1) * scaleY,
                      border: `2px solid ${color}`,
                      backgroundColor: active ? `${color}33` : `${color}14`,
                      borderRadius: '2px',
                      cursor: 'pointer',
                      transition: 'background-color .15s ease, box-shadow .15s ease',
                      boxShadow: active ? `0 0 0 2px ${color}` : 'none',
                    }}
                  />
                );
              })}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            このページの画像はありません（ブロック一覧のみ表示）。
          </Typography>
        )}
      </Box>
    </Card>
  );
}

interface BlocksPanelProps {
  page: OcrPreviewPage;
  hoveredId: string | null;
  setHoveredId: (v: string | null) => void;
  onSelect: (b: OcrPreviewBlock) => void;
}

function BlocksPanel({ page, hoveredId, setHoveredId, onSelect }: BlocksPanelProps) {
  return (
    <Card sx={{ display: 'flex', flexDirection: 'column', maxHeight: 648 }}>
      <Box sx={{ p: 1.5, borderBottom: (t) => `1px solid ${t.palette.divider}` }}>
        <Typography variant="subtitle1">
          検出ブロック（{page.blocks.length}）
        </Typography>
      </Box>
      <Box sx={{ overflowY: 'auto', p: 1.5 }}>
        <Stack spacing={1}>
          {page.blocks.map((block) => (
            <BlockItem
              key={block.id}
              block={block}
              active={hoveredId === block.id}
              onHover={setHoveredId}
              onSelect={onSelect}
            />
          ))}
          {page.blocks.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              検出されたブロックがありません。
            </Typography>
          )}
        </Stack>
      </Box>
    </Card>
  );
}

interface BlockItemProps {
  block: OcrPreviewBlock;
  active: boolean;
  onHover: (id: string | null) => void;
  onSelect: (b: OcrPreviewBlock) => void;
}

function BlockItem({ block, active, onHover, onSelect }: BlockItemProps) {
  const color = blockColor(block.label);
  const isTable = block.label.includes('table');
  return (
    <Box
      onMouseEnter={() => onHover(block.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(block)}
      sx={{
        p: 1.25,
        borderRadius: 2,
        border: (t) => `1px solid ${active ? color : t.palette.divider}`,
        borderLeft: `4px solid ${color}`,
        cursor: 'pointer',
        bgcolor: active ? `${color}14` : 'transparent',
        transition: 'background-color .15s ease, border-color .15s ease',
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}
      >
        <Chip
          size="small"
          label={blockLabelJa(block.label)}
          sx={{ bgcolor: `${color}1f`, color, fontWeight: 700 }}
        />
        <Typography variant="caption" color="text.secondary">
          {block.confidence != null && `信頼度 ${(block.confidence * 100).toFixed(1)}%`}
        </Typography>
      </Stack>
      {isTable ? (
        <Box
          sx={tableSx}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify でサニタイズ済み
          dangerouslySetInnerHTML={{ __html: sanitize(block.text) }}
        />
      ) : isVisualLabel(block.label) ? (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {block.text || '（視覚要素）'}
        </Typography>
      ) : (
        <Typography
          variant="body2"
          sx={{
            whiteSpace: 'pre-wrap',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {block.text || '（テキストなし）'}
        </Typography>
      )}
    </Box>
  );
}

function BlockDetailDialog({
  block,
  onClose,
}: {
  block: OcrPreviewBlock | null;
  onClose: () => void;
}) {
  const open = block !== null;
  const isTable = block?.label.includes('table') ?? false;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      {block && (
        <>
          <DialogTitle>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Chip
                size="small"
                label={blockLabelJa(block.label)}
                sx={{
                  bgcolor: `${blockColor(block.label)}1f`,
                  color: blockColor(block.label),
                  fontWeight: 700,
                }}
              />
              <Typography variant="body2" color="text.secondary">
                #{block.id}
                {block.confidence != null &&
                  ` ・ 信頼度 ${(block.confidence * 100).toFixed(1)}%`}
                {block.bbox && ` ・ bbox [${block.bbox.map((n) => Math.round(n)).join(', ')}]`}
              </Typography>
            </Stack>
          </DialogTitle>
          <DialogContent dividers>
            {isTable ? (
              <Box
                sx={tableSx}
                // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify でサニタイズ済み
                dangerouslySetInnerHTML={{ __html: sanitize(block.text) }}
              />
            ) : (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                {block.text || '（内容なし）'}
              </Typography>
            )}
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const tableSx = {
  overflowX: 'auto',
  '& table': { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  '& td, & th': {
    border: (t: { palette: { divider: string } }) => `1px solid ${t.palette.divider}`,
    p: 0.5,
  },
} as const;
