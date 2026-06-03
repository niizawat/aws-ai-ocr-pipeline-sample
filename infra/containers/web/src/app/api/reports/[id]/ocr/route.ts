import { NextResponse } from 'next/server';

import { getOcrPreview } from '@/lib/aws/ocr';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const preview = await getOcrPreview(id);
    return NextResponse.json(preview);
  } catch (error) {
    return errorResponse(error);
  }
}
