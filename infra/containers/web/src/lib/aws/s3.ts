import 'server-only';

import {
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { awsClients } from '@/lib/aws/clients';
import { env } from '@/lib/env';

const EXPIRES_IN = 3600;

/** raw/ プレフィックスへのアップロード用 presigned PUT URL を発行する。 */
export async function createUploadUrl(
  fileName: string,
  contentType: string,
): Promise<{ key: string; url: string }> {
  const bucket = env.s3Bucket();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 15)
    .replace(/(\d{8})(\d{6})/, '$1_$2');
  const fileId = crypto.randomUUID().slice(0, 8);
  const key = `raw/${timestamp}_${fileId}_${fileName}`;

  const url = await getSignedUrl(
    awsClients.s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    }),
    { expiresIn: EXPIRES_IN },
  );
  return { key, url };
}

/** 任意のオブジェクトのダウンロード用 presigned GET URL を発行する。 */
export async function createDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    awsClients.s3,
    new GetObjectCommand({ Bucket: env.s3Bucket(), Key: key }),
    { expiresIn: EXPIRES_IN },
  );
}

/** images/{reportId}/ 配下の画像 presigned URL 一覧を返す。 */
export async function listReportImages(
  reportId: string,
): Promise<{ key: string; name: string; url: string }[]> {
  const bucket = env.s3Bucket();
  const prefix = `images/${reportId}/`;
  const res = await awsClients.s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 10 }),
  );
  const objects = res.Contents ?? [];
  const result: { key: string; name: string; url: string }[] = [];
  for (const obj of objects) {
    if (!obj.Key || obj.Key.endsWith('/')) continue;
    const name = obj.Key.split('/').pop() ?? obj.Key;
    // LibreOffice も同プレフィックスに input.png 等を出力するため page-*.png のみ対象にする
    if (!name.startsWith('page-')) continue;
    const url = await createDownloadUrl(obj.Key);
    result.push({ key: obj.Key, name, url });
  }
  return result;
}
