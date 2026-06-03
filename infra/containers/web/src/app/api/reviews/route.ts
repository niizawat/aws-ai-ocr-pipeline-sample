import { NextResponse } from 'next/server';

import { queryByStatus } from '@/lib/aws/reports';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['pending_review', 'completed', 'reviewed', 'human_reviewed']);

/** UI「レビュー完了」タブは A2I 人間レビュー済み（human_reviewed）のみ。 */
function resolveStatus(status: string): string {
  if (status === 'reviewed') return 'human_reviewed';
  return status;
}

export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get('status') ?? 'pending_review';
    if (!ALLOWED.has(raw)) {
      return NextResponse.json(
        {
          error:
            'status は pending_review、human_reviewed（または reviewed）、completed を指定してください。',
        },
        { status: 400 },
      );
    }
    const status = resolveStatus(raw);
    const items = await queryByStatus(status);
    return NextResponse.json({ status, items });
  } catch (error) {
    return errorResponse(error);
  }
}
