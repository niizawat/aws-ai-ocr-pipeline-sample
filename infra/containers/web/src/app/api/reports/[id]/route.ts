import { NextResponse } from 'next/server';

import { getReportSections } from '@/lib/aws/reports';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sections = await getReportSections(id);
    return NextResponse.json({ reportId: id, sections });
  } catch (error) {
    return errorResponse(error);
  }
}
