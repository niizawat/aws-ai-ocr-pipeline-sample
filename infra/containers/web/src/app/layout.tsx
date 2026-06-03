import type { Metadata, Viewport } from 'next';
import { Manrope, Noto_Sans_JP } from 'next/font/google';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';

import './globals.css';
import Providers from '@/theme/Providers';
import AppShell from '@/components/AppShell';
import { APP_TITLE } from '@/components/nav';

const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-app',
});

const notoSansJp = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-jp',
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description: '製造品質レポートの OCR 解析結果を可視化・横断検索する分析プラットフォーム',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" suppressHydrationWarning className={`${manrope.variable} ${notoSansJp.variable}`}>
      <body>
        <InitColorSchemeScript attribute="class" />
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
