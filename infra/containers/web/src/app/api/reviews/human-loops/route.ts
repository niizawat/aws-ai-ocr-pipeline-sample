import { NextResponse } from 'next/server';

import { listHumanLoops } from '@/lib/aws/reviews';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await listHumanLoops();
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
