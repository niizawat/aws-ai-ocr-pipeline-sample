import { NextResponse } from 'next/server';

import { getLabelingPortalUrl } from '@/lib/aws/reviews';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** SageMaker Private Workforce ラベリングポータルの URL を返す。 */
export async function GET() {
  try {
    const portal = await getLabelingPortalUrl();
    return NextResponse.json(portal);
  } catch (error) {
    return errorResponse(error);
  }
}
