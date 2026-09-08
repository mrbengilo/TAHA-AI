// Fixed SELECT statements only. Never decrypt credentials or print content_json/draft copy.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const W = '00000000-0000-4000-8000-000000000001';
const P = '03052129-8a8e-4695-b68a-f5442d50a6bd';
const C = 'de367230-7460-4964-ba4c-5754819efce6';
const K = 'owner-website-trial-PH0015-2026-09-08-v1';

function select(sql) {
  if (!sql.startsWith('SELECT ') || sql.includes(';')) throw Error('SELECT_ONLY');
  const raw = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(raw);
  if (data.length !== 1 || !data[0]?.success || !Array.isArray(data[0].results)) throw Error('SELECT_FAILED');
  return data[0].results;
}

function main() {
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  const state = {
    sku: 'PH0015',
    // App contract is exactly "1". Treat other truthy/unknown spellings as unsafe for a trial.
    backfillEnabled: env.WEBSITE_READY_BACKFILL_ENABLED === '1',
    backfillExplicitlyDisabled: ['0', 'false'].includes(env.WEBSITE_READY_BACKFILL_ENABLED),
    internalCredentialPresent: Boolean(env.INTERNAL_API_SECRET),
    products: select(`SELECT id,base_sku,status FROM products WHERE workspace_id='${W}' AND (id='${P}' OR base_sku='PH0015') AND deleted_at IS NULL`),
    connection: select(`SELECT id,provider,status,publish_mode,CASE WHEN auth_ciphertext IS NOT NULL AND length(auth_ciphertext)>0 THEN 1 ELSE 0 END AS hasCredentials,CASE WHEN json_extract(config_json,'$.publishEndpoint')='https://tahashoes.vn/api/taha/publish' THEN 1 ELSE 0 END AS endpointMatches FROM channel_connections WHERE workspace_id='${W}' AND id='${C}'`),
    runs: select(`SELECT id,product_id,status,requested_image_count,completed_image_count,CASE WHEN request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey,CASE WHEN target_providers_json='["website"]' THEN 1 ELSE 0 END AS websiteOnly,json_extract(content_json,'$.prepareOnly') AS prepareOnly,CASE WHEN json_extract(content_json,'$.targetConnections.website')='${C}' THEN 1 ELSE 0 END AS connectionMatches,created_at,updated_at FROM automation_runs WHERE workspace_id='${W}' AND (product_id='${P}' OR request_key='${K}') ORDER BY created_at DESC LIMIT 30`),
    jobs: select(`SELECT j.id,j.status,j.attempt_count,j.connection_id,j.dedupe_key,j.external_post_id,CASE WHEN j.external_url LIKE 'https://tahashoes.vn/product/%' THEN 1 ELSE 0 END AS hasPublicProductUrl,j.scheduled_for,j.completed_at,CASE WHEN r.request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey FROM publish_jobs j LEFT JOIN content_drafts d ON d.id=j.draft_id LEFT JOIN automation_runs r ON r.id=json_extract(d.platform_data_json,'$.automationRunId') JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND j.product_id='${P}' AND c.provider='website' ORDER BY j.created_at DESC LIMIT 30`),
    schedules: select(`SELECT s.id,s.status,s.next_run_at,CASE WHEN s.created_by='automation:'||r.id AND r.request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey FROM schedules s JOIN content_drafts d ON d.id=s.draft_id JOIN channel_connections c ON c.id=s.connection_id LEFT JOIN automation_runs r ON r.id=json_extract(d.platform_data_json,'$.automationRunId') WHERE s.workspace_id='${W}' AND d.product_id='${P}' AND c.provider='website' ORDER BY s.created_at DESC LIMIT 30`),
    websiteJobsByStatus: select(`SELECT j.status,COUNT(*) AS count FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND c.provider='website' GROUP BY j.status`),
    activeWebsiteSchedules: select(`SELECT COUNT(*) AS count FROM schedules s JOIN channel_connections c ON c.id=s.connection_id WHERE s.workspace_id='${W}' AND c.provider='website' AND s.status='active'`),
    activeWebsiteRuns: select(`SELECT COUNT(*) AS count FROM automation_runs r WHERE r.workspace_id='${W}' AND r.status IN ('queued','processing') AND EXISTS (SELECT 1 FROM json_each(r.target_providers_json) WHERE value='website')`),
  };
  // String values are identifiers/statuses only; block unexpected free text from entering logs.
  const safe = JSON.stringify(state, (_key, value) => typeof value === 'string'
    && !/^[A-Za-z0-9_.:\-]{0,220}$/.test(value) ? '[UNEXPECTED_VALUE]' : value);
  console.log('WEBSITE_STATE_DIAG=' + safe);
}

try { main(); } catch { console.log('WEBSITE_STATE_DIAG_FAILED'); process.exitCode = 1; }
