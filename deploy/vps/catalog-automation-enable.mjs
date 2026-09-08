// Internal-only operations for the owner's daily Facebook / immediate website policy.
// Never print credentials, draft text, or raw API/SQL responses.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const W = '00000000-0000-4000-8000-000000000001';
function query(sql) {
  const raw = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const rows = JSON.parse(raw);
  if (rows.length !== 1 || !rows[0]?.success) throw Error('CATALOG_QUERY_FAILED');
  return rows[0].results;
}

async function main() {
  const mode = process.argv[2];
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  if (!env.INTERNAL_API_SECRET) throw Error('CATALOG_INTERNAL_AUTH_MISSING');
  if (mode === 'health') {
    const response = await fetch('http://127.0.0.1:8787/api/integrations', {
      headers: { authorization: `Bearer ${env.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('CATALOG_HEALTH_FAILED');
    console.log('CATALOG_HEALTH_OK');
    return;
  }
  if (mode === 'configure') {
    const connections = query(`SELECT provider,publish_mode,id FROM channel_connections WHERE workspace_id='${W}' AND status='connected' AND provider IN ('google','facebook','website')`);
    for (const provider of ['google', 'facebook', 'website']) {
      const rows = connections.filter(row => row.provider === provider);
      if (rows.length !== 1 || (provider !== 'google' && rows[0].publish_mode !== 'api')) throw Error('CATALOG_CONNECTION_AMBIGUOUS');
    }
    query(`UPDATE channel_connections SET config_json=json_set(config_json,'$.dailyAutomationEnabled',1) WHERE workspace_id='${W}' AND provider='facebook' AND status='connected' AND publish_mode='api' RETURNING provider`);
    query(`UPDATE channel_connections SET config_json=json_set(config_json,'$.dailyAutomationEnabled',0) WHERE workspace_id='${W}' AND provider='website' AND status='connected' RETURNING provider`);
    console.log('CATALOG_POLICY_CONFIGURED=' + JSON.stringify({ facebookDaily: true, websiteDailyLimit: false, generatedImages: false }));
    return;
  }
  if (mode === 'tick') {
    if (env.WEBSITE_READY_BACKFILL_ENABLED !== '1') throw Error('CATALOG_WEBSITE_FLAG_DISABLED');
    const response = await fetch('http://127.0.0.1:8787/api/internal/cron/tick', {
      method: 'POST', headers: { authorization: `Bearer ${env.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(600000),
    });
    if (!response.ok) throw Error('CATALOG_TICK_FAILED');
    const { data } = await response.json();
    if (!data) throw Error('CATALOG_TICK_INVALID');
    console.log('CATALOG_TICK_RESULT=' + JSON.stringify({
      googleRefreshed: data.google?.refreshed, googleReason: data.google?.reason,
      website: data.website, dailyQueued: data.daily?.queued, dailyReason: data.daily?.reason,
      published: (data.dispatcher?.published || 0) + (data.websiteDelivery?.dispatcher?.published || 0),
      errors: [...(data.dispatcher?.errors || []), ...(data.websiteDelivery?.dispatcher?.errors || [])].map(item => item.code),
    }));
    return;
  }
  if (mode !== 'status') throw Error('CATALOG_MODE_INVALID');
  const products = query(`SELECT p.base_sku,(SELECT COUNT(*) FROM product_media pm JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id WHERE pm.product_id=p.id AND pm.workspace_id=p.workspace_id AND m.origin='source' AND m.media_type='image' AND m.status='ready') AS originalImages,(SELECT COUNT(*) FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.product_id=p.id AND j.workspace_id=p.workspace_id AND c.provider='website' AND j.status='published') AS websiteReceipts,(SELECT json_array_length(json_extract(j.payload_snapshot_json,'$.mediaIds')) FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.product_id=p.id AND j.workspace_id=p.workspace_id AND c.provider='website' AND j.status='published' ORDER BY j.completed_at DESC LIMIT 1) AS publishedImages FROM products p WHERE p.workspace_id='${W}' AND p.deleted_at IS NULL AND p.status='active' ORDER BY p.base_sku`);
  const jobs = query(`SELECT j.status,COUNT(*) AS count FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND c.provider='website' GROUP BY j.status`);
  const sync = query(`SELECT last_synced_at,json_extract(config_json,'$._dailyCatalogRefreshSucceededDay') AS dailyRefreshedDay FROM channel_connections WHERE workspace_id='${W}' AND provider='google' AND status='connected'`);
  console.log('CATALOG_AUTOMATION_STATUS=' + JSON.stringify({ products, jobs, sync, websiteEnabled: env.WEBSITE_READY_BACKFILL_ENABLED === '1' }));
}
try { await main(); } catch (error) {
  console.error(/^CATALOG_[A-Z_]+$/.test(error?.message || '') ? error.message : 'CATALOG_AUTOMATION_OPERATION_FAILED');
  process.exitCode = 1;
}
