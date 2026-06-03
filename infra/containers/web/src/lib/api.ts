import { NextResponse } from 'next/server';

/** ルートハンドラ共通のエラーレスポンス整形。 */
export function errorResponse(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : '不明なエラーが発生しました。';
  return NextResponse.json({ error: message }, { status });
}
