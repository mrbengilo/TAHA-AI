// Retry only the three confirmed HTTP 413 rejections, retaining original jobs/keys.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const W = '00000000-0000-4000-8000-000000000001';
function query(sql) {
  const data = JSON.parse(execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to=/data',
    '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
  if (data.length !== 1 || !data[0]?.success) throw Error('CAPACITY_QUERY_FAILED');
  return data[0].results;
}
try {
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  if (!env.INTERNAL_API_SECRET || env.WEBSITE_READY_BACKFILL_ENABLED !== '1') throw Error('CAPACITY_POLICY_NOT_READY');
  const now = Date.now();
  const reset = query(`UPDATE publish_jobs SET status='queued',available_at=${now},error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=${now}
    WHERE workspace_id='${W}' AND status='failed' AND error_code='WEBSITE_API_413' AND attempt_count=1
      AND external_post_id IS NULL AND external_url IS NULL AND lease_owner IS NULL
      AND connection_id='de367230-7460-4964-ba4c-5754819efce6'
      AND product_id IN (SELECT id FROM products WHERE workspace_id='${W}' AND base_sku IN ('PH0022','PH0028','PH0029'))
      AND draft_id IN (SELECT id FROM content_drafts WHERE workspace_id='${W}' AND generator='website-backfill' AND status='approved')
    RETURNING id`);
  console.log('CAPACITY_REQUEUED=' + reset.length);
  const response = await fetch('http://127.0.0.1:8787/api/internal/cron/tick', {
    method: 'POST', headers: { authorization: `Bearer ${env.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw Error('CAPACITY_TICK_FAILED');
  const { data } = await response.json();
  console.log('CAPACITY_DELIVERY=' + JSON.stringify({ published: data?.dispatcher?.published,
    errors: data?.dispatcher?.errors?.map(item => item.code), website: data?.website }));
} catch (error) {
  console.error(/^CAPACITY_[A-Z_]+$/.test(error?.message || '') ? error.message : 'CAPACITY_RETRY_FAILED');
  process.exitCode = 1;
}
