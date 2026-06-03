import { NextResponse } from 'next/server';

import { ragQuery } from '@/lib/aws/rag';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { query?: string };
    const query = body.query?.trim();
    if (!query) {
      return NextResponse.json({ error: 'query は必須です。' }, { status: 400 });
    }
    const result = await ragQuery(query);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
