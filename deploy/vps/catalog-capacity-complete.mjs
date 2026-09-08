// Retry the three observed 413-only jobs after receiver capacity is repaired.
// Preserve immutable payloads, delivery keys and attempt history.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const W = '00000000-0000-4000-8000-000000000001';
function query(sql) {
  const rows = JSON.parse(execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
  if (rows.length !== 1 || !rows[0]?.success) throw Error('CATALOG_CAPACITY_QUERY_FAILED');
  return rows[0].results;
}
try {
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  if (!env.INTERNAL_API_SECRET || env.WEBSITE_READY_BACKFILL_ENABLED !== '1') throw Error('CATALOG_CAPACITY_POLICY_DISABLED');
  const now = Date.now();
  const rows = query(`UPDATE publish_jobs SET status='queued',available_at=${now},error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=${now}
    WHERE workspace_id='${W}' AND status='failed' AND error_code='WEBSITE_API_413' AND attempt_count IN (1,2)
      AND external_post_id IS NULL AND external_url IS NULL AND lease_owner IS NULL
      AND connection_id='de367230-7460-4964-ba4c-5754819efce6'
      AND product_id IN (SELECT id FROM products WHERE workspace_id='${W}' AND base_sku IN ('PH0022','PH0028','PH0029'))
      AND draft_id IN (SELECT id FROM content_drafts WHERE workspace_id='${W}' AND generator='website-backfill' AND status='approved')
    RETURNING id`);
  console.log('CATALOG_CAPACITY_REQUEUED=' + rows.length);
  const response = await fetch('http://127.0.0.1:8787/api/internal/cron/tick', {
    method: 'POST', headers: { authorization: `Bearer ${env.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw Error('CATALOG_CAPACITY_TICK_FAILED');
  const { data } = await response.json();
  if (!data) throw Error('CATALOG_CAPACITY_TICK_INVALID');
  const errors = [...(data.dispatcher?.errors || []), ...(data.websiteDelivery?.dispatcher?.errors || [])].map(item => item.code);
  console.log('CATALOG_CAPACITY_DELIVERY=' + JSON.stringify({
    published: (data.dispatcher?.published || 0) + (data.websiteDelivery?.dispatcher?.published || 0),
    errors, website: data.website,
  }));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.log(/^CATALOG_[A-Z_]+$/.test(error?.message || '') ? error.message : 'CATALOG_CAPACITY_FAILED');
  process.exitCode = 1;
}
