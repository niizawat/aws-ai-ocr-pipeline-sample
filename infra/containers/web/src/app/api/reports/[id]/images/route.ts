import { NextResponse } from 'next/server';

import { listReportImages } from '@/lib/aws/s3';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const images = await listReportImages(id);
    return NextResponse.json({ images });
  } catch (error) {
    return errorResponse(error);
  }
}
