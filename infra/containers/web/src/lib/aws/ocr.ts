import 'server-only';

import { GetObjectCommand } from '@aws-sdk/client-s3';

import { awsClients } from '@/lib/aws/clients';
import { env } from '@/lib/env';
import { listReportImages } from '@/lib/aws/s3';
import type { Bbox, OcrPreview, OcrPreviewBlock, OcrPreviewPage } from '@/lib/types';

interface RawRegion {
  regionId?: string;
  page?: number;
  blockLabel?: string;
  text?: string;
  bbox?: number[] | null;
  confidence?: number;
  pageWidth?: number | null;
  pageHeight?: number | null;
}

interface RawPageSize {
  page?: number;
  width?: number | null;
  height?: number | null;
}

interface OcrResultsFile {
  status?: string;
  confidence?: number;
  ocrResults?: {
    regions?: RawRegion[];
    pageSizes?: RawPageSize[];
    markdown?: string;
  };
}

interface NormalizedSection {
  sectionId?: string;
  sectionType?: string;
  pageNumber?: number;
  content?: string;
}

interface NormalizedResult {
  sections?: NormalizedSection[];
}

function toBbox(bbox?: number[] | null): Bbox | null {
  if (!bbox || bbox.length < 4) return null;
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

async function readS3Json<T>(key: string): Promise<T | null> {
  try {
    const res = await awsClients.s3.send(
      new GetObjectCommand({ Bucket: env.s3Bucket(), Key: key }),
    );
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as T;
  } catch (error) {
    const name = (error as { name?: string }).name;
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
    throw error;
  }
}

async function readOcrResults(reportId: string): Promise<OcrResultsFile | null> {
  return readS3Json<OcrResultsFile>(`ocr-results/${reportId}.json`);
}

/**
 * レポートの OCR プレビュー payload を構築する。
 * - ブロック（bbox/label/text/confidence）は ocr-results/{id}.json の regions から取得
 * - ページ画像は images/{id}/ を名前順に並べ、page 番号（1始まり）に対応付ける
 * - bbox スケール基準の width/height は pageSizes（無ければ region.pageWidth/Height）
 */
export async function getOcrPreview(reportId: string): Promise<OcrPreview> {
  const [results, normalized, images] = await Promise.all([
    readOcrResults(reportId),
    readS3Json<NormalizedResult>(`results/${reportId}/result.json`),
    listReportImages(reportId),
  ]);

  if (!results?.ocrResults) {
    return { available: false, pages: [] };
  }

  const regions = results.ocrResults.regions ?? [];
  const pageSizes = results.ocrResults.pageSizes ?? [];
  const sortedImages = [...images].sort((a, b) => a.name.localeCompare(b.name));

  const sizeByPage = new Map<number, { width: number | null; height: number | null }>();
  for (const ps of pageSizes) {
    if (typeof ps.page === 'number') {
      sizeByPage.set(ps.page, {
        width: ps.width ?? null,
        height: ps.height ?? null,
      });
    }
  }

  // ブロックをページごとに集約
  const blocksByPage = new Map<number, OcrPreviewBlock[]>();
  regions.forEach((region, idx) => {
    const page = typeof region.page === 'number' ? region.page : 1;
    const block: OcrPreviewBlock = {
      id: region.regionId ?? `region-${idx}`,
      page,
      label: region.blockLabel ?? 'text',
      text: region.text ?? '',
      bbox: toBbox(region.bbox),
      confidence: typeof region.confidence === 'number' ? region.confidence : null,
    };
    if (!sizeByPage.has(page) && (region.pageWidth || region.pageHeight)) {
      sizeByPage.set(page, {
        width: region.pageWidth ?? null,
        height: region.pageHeight ?? null,
      });
    }
    const list = blocksByPage.get(page) ?? [];
    list.push(block);
    blocksByPage.set(page, list);
  });

  // photo-interpretation / pdf-page / pdf-table セクションを bbox なしブロックとして追加
  const TARGET_TYPES = new Set(['photo-interpretation', 'pdf-page', 'pdf-table']);
  for (const section of normalized?.sections ?? []) {
    if (!TARGET_TYPES.has(section.sectionType ?? '')) continue;
    const page = section.pageNumber ?? 1;
    const label =
      section.sectionType === 'photo-interpretation'
        ? 'photo-interpretation'
        : section.sectionType === 'pdf-table'
          ? 'pdf-table'
          : 'pdf-page';
    const block: OcrPreviewBlock = {
      id: section.sectionId ?? `${label}-${page}`,
      page,
      label,
      text: section.content ?? '',
      bbox: null,
      confidence: null,
    };
    const list = blocksByPage.get(page) ?? [];
    list.push(block);
    blocksByPage.set(page, list);
  }

  // ページ番号の集合（regions と画像枚数の和集合）
  const pageNumbers = new Set<number>(blocksByPage.keys());
  sortedImages.forEach((_, i) => {
    pageNumbers.add(i + 1);
  });
  const orderedPages = [...pageNumbers].sort((a, b) => a - b);

  const pages: OcrPreviewPage[] = orderedPages.map((page) => {
    const image = sortedImages[page - 1] ?? null;
    const size = sizeByPage.get(page) ?? { width: null, height: null };
    return {
      page,
      imageUrl: image?.url ?? null,
      imageName: image?.name ?? null,
      width: size.width,
      height: size.height,
      blocks: blocksByPage.get(page) ?? [],
    };
  });

  return {
    available: pages.length > 0,
    status: results.status,
    confidence: results.confidence,
    markdown: results.ocrResults.markdown,
    pages,
  };
}
