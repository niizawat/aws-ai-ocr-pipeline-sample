export interface ReportItem {
  report_id: string;
  page_section: string;
  source_file?: string;
  source_type?: string;
  extracted_at?: string;
  confidence_score?: string;
  review_status?: string;
  report_date?: string;
  content_text?: string;
  [key: string]: unknown;
}

export interface ReportListRow {
  report_id: string;
  source_file: string;
  source_type: string;
  extracted_at: string;
  review_status: string;
  confidence_score: string;
}

export interface DashboardMetrics {
  hasData: boolean;
  totalReports: number;
  completionRate: number;
  pendingReview: number;
  avgConfidence: number;
  monthly: { month: string; count: number }[];
  defectPareto: { defectType: string; count: number; cumulativePct: number }[];
  statusBreakdown: { status: string; count: number }[];
}

export interface RagReference {
  reportId: string;
  reportDate: string;
}

export interface RagAnswer {
  answer: string;
  references: RagReference[];
  found: boolean;
}

export interface HumanLoopSummary {
  name: string;
  status: string;
  creationTime: string;
}

export interface PresignedUpload {
  name: string;
  key: string;
  url: string;
  contentType: string;
}

export type Bbox = [number, number, number, number];

/** OCR プレビュー: 検出ブロック（aws-ocr-vision-lab の OcrBlock 相当） */
export interface OcrPreviewBlock {
  id: string;
  page: number;
  label: string;
  text: string;
  bbox: Bbox | null;
  confidence: number | null;
}

/** OCR プレビュー: ページ単位（元画像 + ブロック群 + OCR 座標基準サイズ） */
export interface OcrPreviewPage {
  page: number;
  imageUrl: string | null;
  imageName: string | null;
  width: number | null;
  height: number | null;
  blocks: OcrPreviewBlock[];
}

export interface OcrPreview {
  available: boolean;
  status?: string;
  confidence?: number;
  markdown?: string;
  pages: OcrPreviewPage[];
}
