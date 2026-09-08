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
  const state = { sections: {} };
  try {
    const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
    Object.assign(state, {
    sku: 'PH0015',
    // App contract is exactly "1". Treat other truthy/unknown spellings as unsafe for a trial.
    backfillEnabled: env.WEBSITE_READY_BACKFILL_ENABLED === '1',
    backfillExplicitlyDisabled: ['0', 'false'].includes(env.WEBSITE_READY_BACKFILL_ENABLED),
    internalCredentialPresent: Boolean(env.INTERNAL_API_SECRET),
    });
    state.sections.environment = { ok: true };
  } catch { state.sections.environment = { ok: false, errorClass: 'EnvironmentReadError' }; }
  const queries = {
    products: `SELECT id,base_sku,status FROM products WHERE workspace_id='${W}' AND (id='${P}' OR base_sku='PH0015') AND deleted_at IS NULL`,
    connection: `SELECT id,provider,status,publish_mode,CASE WHEN auth_ciphertext IS NOT NULL AND length(auth_ciphertext)>0 THEN 1 ELSE 0 END AS hasCredentials,CASE WHEN json_extract(config_json,'$.publishEndpoint')='https://tahashoes.vn/api/taha/publish' THEN 1 ELSE 0 END AS endpointMatches FROM channel_connections WHERE workspace_id='${W}' AND id='${C}'`,
    runs: `SELECT id,product_id,status,requested_image_count,completed_image_count,CASE WHEN request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey,CASE WHEN target_providers_json='["website"]' THEN 1 ELSE 0 END AS websiteOnly,json_extract(content_json,'$.prepareOnly') AS prepareOnly,CASE WHEN json_extract(content_json,'$.targetConnections.website')='${C}' THEN 1 ELSE 0 END AS connectionMatches,created_at,updated_at FROM automation_runs WHERE workspace_id='${W}' AND (product_id='${P}' OR request_key='${K}') ORDER BY created_at DESC LIMIT 30`,
    jobs: `SELECT j.id,j.status,j.attempt_count,j.connection_id,j.dedupe_key,j.external_post_id,CASE WHEN j.external_url='https://tahashoes.vn/product/'||j.external_post_id THEN 1 ELSE 0 END AS hasPublicProductUrl,j.scheduled_for,j.completed_at,CASE WHEN r.request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey FROM publish_jobs j LEFT JOIN content_drafts d ON d.id=j.draft_id LEFT JOIN automation_runs r ON r.id=json_extract(d.platform_data_json,'$.automationRunId') JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND j.product_id='${P}' AND c.provider='website' ORDER BY j.created_at DESC LIMIT 30`,
    schedules: `SELECT s.id,s.status,s.next_run_at,CASE WHEN s.created_by='automation:'||r.id AND r.request_key='${K}' THEN 1 ELSE 0 END AS isExactTrialKey FROM schedules s JOIN content_drafts d ON d.id=s.draft_id JOIN channel_connections c ON c.id=s.connection_id LEFT JOIN automation_runs r ON r.id=json_extract(d.platform_data_json,'$.automationRunId') WHERE s.workspace_id='${W}' AND d.product_id='${P}' AND c.provider='website' ORDER BY s.created_at DESC LIMIT 30`,
    websiteJobsByStatus: `SELECT j.status,COUNT(*) AS count FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND c.provider='website' GROUP BY j.status`,
    activeWebsiteSchedules: `SELECT COUNT(*) AS count FROM schedules s JOIN channel_connections c ON c.id=s.connection_id WHERE s.workspace_id='${W}' AND c.provider='website' AND s.status='active'`,
    activeWebsiteRuns: `SELECT COUNT(*) AS count FROM automation_runs r WHERE r.workspace_id='${W}' AND r.status IN ('queued','processing') AND EXISTS (SELECT 1 FROM json_each(r.target_providers_json) WHERE value='website')`,
    dailyWebsiteConnections: `SELECT COUNT(*) AS count FROM channel_connections WHERE workspace_id='${W}' AND provider='website' AND status='connected' AND json_extract(config_json,'$.dailyAutomationEnabled')=1`,
    catalogCount: `SELECT status,COUNT(*) AS count FROM products WHERE workspace_id='${W}' AND deleted_at IS NULL GROUP BY status`,
    catalogReadiness: `SELECT p.id,p.base_sku,p.status,(SELECT COUNT(*) FROM product_media pm JOIN media_assets m ON m.id=pm.media_id AND m.workspace_id=pm.workspace_id WHERE pm.product_id=p.id AND pm.workspace_id=p.workspace_id AND m.origin='source' AND m.media_type='image' AND m.status='ready') AS originalImages,(SELECT COUNT(*) FROM content_drafts d WHERE d.product_id=p.id AND d.workspace_id=p.workspace_id AND d.archived_at IS NULL AND d.target_provider='facebook') AS facebookDrafts,(SELECT COUNT(*) FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id WHERE j.product_id=p.id AND j.workspace_id=p.workspace_id AND c.provider='website' AND j.status='published') AS websitePublished,json_array_length(json_extract(p.metadata_json,'$.website.sizes')) AS sizes FROM products p WHERE p.workspace_id='${W}' AND p.deleted_at IS NULL ORDER BY p.base_sku LIMIT 500`,
    channelPolicy: `SELECT id,provider,status,publish_mode,last_synced_at,json_extract(config_json,'$.dailyAutomationEnabled') AS dailyEnabled FROM channel_connections WHERE workspace_id='${W}' AND provider IN ('google','facebook','website') ORDER BY provider,id`,
    facebookSchedule: `SELECT s.id,s.status,s.schedule_kind,s.next_run_at,s.timezone FROM schedules s JOIN channel_connections c ON c.id=s.connection_id WHERE s.workspace_id='${W}' AND c.provider='facebook' AND s.status='active' ORDER BY s.next_run_at LIMIT 20`,
    automationTotals: `SELECT status,COUNT(*) AS count FROM automation_runs WHERE workspace_id='${W}' GROUP BY status`,
  };
  for (const [stage, sql] of Object.entries(queries)) {
    try {
      state[stage] = select(sql);
      state.sections[stage] = { ok: true };
    } catch (error) {
      state[stage] = null;
      state.sections[stage] = { ok: false, errorClass: 'SelectError', returnCode: Number.isInteger(error?.status) ? error.status : null };
    }
    console.log('WEBSITE_STATE_PROGRESS=' + JSON.stringify({ stage, ...state.sections[stage] }));
  }
  // String values are identifiers/statuses only; block unexpected free text from entering logs.
  const safe = JSON.stringify(state, (_key, value) => typeof value === 'string'
    && !/^[A-Za-z0-9_.:-]{0,220}$/.test(value) ? '[UNEXPECTED_VALUE]' : value);
  console.log('WEBSITE_STATE_DIAG=' + safe);
  if (Object.values(state.sections).some(section => !section.ok)) process.exitCode = 1;
}

try { main(); } catch { console.log('WEBSITE_STATE_DIAG_FAILED'); process.exitCode = 1; }
