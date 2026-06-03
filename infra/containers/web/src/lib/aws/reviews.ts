import 'server-only';

import { DescribeWorkteamCommand } from '@aws-sdk/client-sagemaker';
import { ListHumanLoopsCommand } from '@aws-sdk/client-sagemaker-a2i-runtime';

import { awsClients } from '@/lib/aws/clients';
import { env } from '@/lib/env';
import type { HumanLoopSummary } from '@/lib/types';

/** DescribeWorkteam の SubDomain はプレフィックスのみ、または FQDN のどちらかが返る。 */
export function buildLabelingPortalUrl(subdomain: string, region: string): string {
  const trimmed = subdomain.trim().replace(/^https?:\/\//, '');
  if (!trimmed) return '';
  if (trimmed.includes('.labeling.')) {
    return `https://${trimmed}`;
  }
  return `https://${trimmed}.labeling.${region}.sagemaker.aws`;
}

/** Private Workforce のラベリングポータル URL（DescribeWorkteam の SubDomain から構築）。 */
export async function getLabelingPortalUrl(): Promise<{
  configured: boolean;
  url: string;
  workteamName: string;
}> {
  const workteamName = env.workteamName();
  if (!workteamName) {
    return { configured: false, url: '', workteamName: '' };
  }

  const res = await awsClients.sagemaker.send(
    new DescribeWorkteamCommand({ WorkteamName: workteamName }),
  );
  const subdomain = res.Workteam?.SubDomain;
  if (!subdomain) {
    return { configured: false, url: '', workteamName };
  }

  const url = buildLabelingPortalUrl(subdomain, env.region);
  return { configured: true, url, workteamName };
}

/** A2I Human Loop 一覧（最新 20 件）を返す。FLOW_DEFINITION_ARN 未設定時は空配列。 */
export async function listHumanLoops(): Promise<{
  configured: boolean;
  loops: HumanLoopSummary[];
}> {
  const flowArn = env.flowDefinitionArn();
  if (!flowArn) {
    return { configured: false, loops: [] };
  }

  const res = await awsClients.sagemakerA2i.send(
    new ListHumanLoopsCommand({
      FlowDefinitionArn: flowArn,
      SortOrder: 'Descending',
      MaxResults: 20,
    }),
  );

  const loops = (res.HumanLoopSummaries ?? []).map((loop) => ({
    name: loop.HumanLoopName ?? '',
    status: loop.HumanLoopStatus ?? '',
    creationTime: loop.CreationTime
      ? new Date(loop.CreationTime).toISOString()
      : '',
  }));

  return { configured: true, loops };
}
