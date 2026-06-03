import { NextResponse } from 'next/server';

import { listReports } from '@/lib/aws/reports';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const reports = await listReports();
    return NextResponse.json({ reports });
  } catch (error) {
    return errorResponse(error);
  }
}
