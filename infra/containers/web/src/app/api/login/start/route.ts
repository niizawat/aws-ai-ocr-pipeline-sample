import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';

function resolveAuthBaseUrl(request: NextRequest): string {
  const configured = process.env.BETTER_AUTH_URL;
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ??
    request.headers.get('host');
  const proto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'https';

  if (host) {
    return `${proto}://${host}`;
  }

  return request.nextUrl.origin;
}

function appendSetCookies(
  target: NextResponse,
  source: Response,
): void {
  const cookies =
    typeof source.headers.getSetCookie === 'function'
      ? source.headers.getSetCookie()
      : [];

  if (cookies.length > 0) {
    for (const cookie of cookies) {
      target.headers.append('Set-Cookie', cookie);
    }
    return;
  }

  const setCookie = source.headers.get('set-cookie');
  if (setCookie) {
    target.headers.append('Set-Cookie', setCookie);
  }
}

/**
 * OAuth 開始をサーバー側 302 で行い、oauth_state Cookie を確実にブラウザへ返す。
 * クライアント fetch + redirect では Cookie 保存前に遷移し state_mismatch になることがある。
 */
export async function GET(request: NextRequest) {
  const callbackURL =
    request.nextUrl.searchParams.get('callbackUrl') ??
    request.nextUrl.searchParams.get('callbackURL') ??
    '/';

  const authBaseUrl = resolveAuthBaseUrl(request);
  const signInUrl = new URL('/api/auth/sign-in/social', `${authBaseUrl}/`);

  const authResponse = await auth.handler(
    new Request(signInUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: authBaseUrl,
        host: new URL(authBaseUrl).host,
      },
      body: JSON.stringify({
        provider: 'cognito',
        callbackURL,
        disableRedirect: true,
      }),
    }),
  );

  if (!authResponse.ok) {
    const body = await authResponse.text();
    return NextResponse.json(
      { message: 'Failed to start sign-in', detail: body },
      { status: authResponse.status },
    );
  }

  const data = (await authResponse.json()) as { url?: string };
  if (!data.url) {
    return NextResponse.json(
      { message: 'Sign-in URL missing from auth response' },
      { status: 500 },
    );
  }

  const redirectResponse = NextResponse.redirect(data.url);
  appendSetCookies(redirectResponse, authResponse);
  return redirectResponse;
}
