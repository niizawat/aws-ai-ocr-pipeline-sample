import { NextResponse } from 'next/server';

import { getReportSections } from '@/lib/aws/reports';
import { createDownloadUrl } from '@/lib/aws/s3';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sections = await getReportSections(id);
    const sourceFile = sections.find((s) => s.source_file)?.source_file;
    const sourceType = sections.find((s) => s.source_type)?.source_type ?? '';
    if (!sourceFile) {
      return NextResponse.json(
        { error: '元ファイル情報がありません。' },
        { status: 404 },
      );
    }
    const url = await createDownloadUrl(sourceFile);
    return NextResponse.json({ url, sourceType, key: sourceFile });
  } catch (error) {
    return errorResponse(error);
  }
}
