/**
 * PP-StructureV3 の block_label をカテゴリ別の色へマッピングする。
 * aws-ocr-vision-lab の block-overlay 配色方針を踏襲する。
 */
const COLOR_BY_LABEL: Record<string, string> = {
  doc_title: '#7c3aed',
  paragraph_title: '#2563eb',
  title: '#2563eb',
  text: '#0ea5e9',
  abstract: '#0ea5e9',
  content: '#0ea5e9',
  table: '#16a34a',
  table_title: '#16a34a',
  figure: '#ea580c',
  image: '#ea580c',
  picture: '#ea580c',
  chart: '#ea580c',
  figure_title: '#ea580c',
  formula: '#9333ea',
  formula_number: '#9333ea',
  seal: '#dc2626',
  stamp: '#dc2626',
  header: '#64748b',
  footer: '#64748b',
  page_number: '#64748b',
  number: '#64748b',
  footnote: '#64748b',
  reference: '#0d9488',
  'photo-interpretation': '#d97706',
  'pdf-page': '#0d9488',
  'pdf-table': '#0f766e',
};

const FALLBACK = '#0f766e';

export function blockColor(label: string): string {
  return COLOR_BY_LABEL[label] ?? FALLBACK;
}

const JP_LABEL: Record<string, string> = {
  doc_title: '文書タイトル',
  paragraph_title: '見出し',
  title: '見出し',
  text: '本文',
  table: '表',
  table_title: '表タイトル',
  figure: '図',
  image: '画像',
  picture: '画像',
  chart: 'グラフ',
  figure_title: '図タイトル',
  formula: '数式',
  seal: '押印',
  stamp: '押印',
  header: 'ヘッダー',
  footer: 'フッター',
  page_number: 'ページ番号',
  number: '番号',
  footnote: '脚注',
  reference: '参照',
  'photo-interpretation': '写真解釈',
  'pdf-page': '抽出テキスト',
  'pdf-table': '抽出表',
};

export function blockLabelJa(label: string): string {
  return JP_LABEL[label] ?? label;
}

const VISUAL_LABELS = new Set([
  'figure',
  'image',
  'picture',
  'chart',
  'seal',
  'stamp',
]);

export function isVisualLabel(label: string): boolean {
  return VISUAL_LABELS.has(label);
}
