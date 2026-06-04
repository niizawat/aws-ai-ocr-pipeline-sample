/**
 * Lambda@Edge (origin-request) — OAC + Function URL + POST ボディの SigV4 署名ハッシュ付与。
 *
 * CloudFront OAC は GET/HEAD のみ署名できるが、POST/PUT のボディハッシュを計算しない。
 * Function URL 側で署名検証が失敗して 403 になるため、このハンドラで
 * x-amz-content-sha256 を付与する。
 *
 * 参考: https://zenn.dev/big_tanukiudon/articles/e6a04d6569b252
 */
import { createHash } from 'crypto';

export const handler = async (event) => {
  const request = event.Records[0].cf.request;
  const method = request.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // GET/HEAD は OAC が自動で署名するためヘッダ付与は不要
    return request;
  }

  // POST / PUT / PATCH — ボディの SHA-256 を計算してセット
  let bodyStr = '';
  if (request.body) {
    if (request.body.encoding === 'base64') {
      bodyStr = Buffer.from(request.body.data, 'base64').toString();
    } else {
      bodyStr = request.body.data ?? '';
    }
  }

  const hash = createHash('sha256').update(bodyStr).digest('hex');
  request.headers['x-amz-content-sha256'] = [
    { key: 'x-amz-content-sha256', value: hash },
  ];

  return request;
};
