import { NextResponse } from 'next/server';

import { createUploadUrl } from '@/lib/aws/s3';
import { errorResponse } from '@/lib/api';
import type { PresignedUpload } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PresignRequest {
  files?: { name: string; contentType?: string }[];
}

const ALLOWED_EXT = ['.xlsx', '.pdf'];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PresignRequest;
    const files = body.files ?? [];
    if (files.length === 0) {
      return NextResponse.json({ error: 'files は必須です。' }, { status: 400 });
    }

    const invalid = files.find(
      (f) => !ALLOWED_EXT.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    if (invalid) {
      return NextResponse.json(
        { error: `対応していないファイル形式です: ${invalid.name}` },
        { status: 400 },
      );
    }

    const uploads: PresignedUpload[] = [];
    for (const file of files) {
      const contentType =
        file.contentType ||
        (file.name.toLowerCase().endsWith('.pdf')
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const { key, url } = await createUploadUrl(file.name, contentType);
      uploads.push({ name: file.name, key, url, contentType });
    }

    return NextResponse.json({ uploads });
  } catch (error) {
    return errorResponse(error);
  }
}
