import { NextResponse } from 'next/server';

import { computeDashboardMetrics } from '@/lib/aws/dashboard';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const metrics = await computeDashboardMetrics();
    return NextResponse.json(metrics);
  } catch (error) {
    return errorResponse(error);
  }
}
