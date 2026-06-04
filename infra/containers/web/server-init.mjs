/**
 * Next.js エントリポイント。
 * シークレットは CDK の CloudFormation dynamic reference で環境変数に注入済みのため、
 * このファイルは server.js を起動するだけ。
 */
await import('./server.js');
