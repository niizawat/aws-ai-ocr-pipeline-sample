import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const authEnabled =
  (process.env.AUTH_ENABLED ?? 'false').toLowerCase() === 'true';

/**
 * 認証は Next.js 層で担う。
 * AUTH_ENABLED=false（ローカル開発）の場合は素通しする。
 *
 * ミドルウェア（Edge Runtime）では better-auth を直接 import できないため、
 * セッション Cookie の存在で簡易判定し、未認証なら /login へリダイレクトする。
 * 実際のセッション検証は API ルートハンドラー側で行う。
 */
export default function middleware(request: NextRequest) {
  if (!authEnabled) {
    return NextResponse.next();
  }

  const hasSession =
    request.cookies.has('better-auth.session_token') ||
    request.cookies.has('__Secure-better-auth.session_token');
  if (!hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // 認証フロー・ヘルスチェック・静的アセットは保護対象外
  matcher: [
    '/((?!api/auth|api/health|api/login|login|_next/static|_next/image|favicon.ico).*)',
  ],
};
