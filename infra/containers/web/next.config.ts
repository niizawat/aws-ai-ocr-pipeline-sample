import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname),
  reactStrictMode: true,
  serverExternalPackages: ['better-auth'],
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material', '@mui/x-charts'],
  },
};

export default nextConfig;
