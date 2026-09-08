// SELECT-only and presence-only commerce OAuth diagnosis. Never print secrets or raw callback tokens.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const W = '00000000-0000-4000-8000-000000000001';
function select(sql) {
  if (!/^SELECT\s/iu.test(sql) || sql.includes(';')) throw Error('COMMERCE_SELECT_ONLY');
  const data = JSON.parse(execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000, maxBuffer: 2 * 1024 * 1024 }));
  if (data.length !== 1 || !data[0]?.success || !Array.isArray(data[0].results)) throw Error('COMMERCE_SELECT_FAILED');
  return data[0].results;
}
function presence(env, keys) {
  return Object.fromEntries(keys.map(key => [key, Boolean(env[key]?.trim())]));
}
function exactUrl(value, expected) {
  try {
    const url = new URL(value);
    return value === expected && url.protocol === 'https:' && !url.search && !url.hash;
  } catch { return false; }
}
try {
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  const shared = ['PUBLIC_APP_URL', 'OAUTH_STATE_SECRET', 'INTEGRATION_TOKEN_ENCRYPTION_KEY'];
  const shopee = ['SHOPEE_BASE_URL', 'SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_REDIRECT_URI'];
  const tiktok = ['TIKTOK_SHOP_APP_KEY', 'TIKTOK_SHOP_APP_SECRET', 'TIKTOK_SHOP_SERVICE_ID', 'TIKTOK_SHOP_REDIRECT_URI'];
  const publicOrigin = env.PUBLIC_APP_URL?.replace(/\/$/u, '') || '';
  console.log('COMMERCE_ENV=' + JSON.stringify({
    shared: presence(env, shared), shopee: presence(env, shopee), tiktok: presence(env, tiktok),
    publicOriginHttps: /^https:\/\/[^/]+$/u.test(publicOrigin),
    shopeeBaseOfficial: env.SHOPEE_BASE_URL === 'https://partner.shopeemobile.com',
    shopeeCallbackExact: exactUrl(env.SHOPEE_REDIRECT_URI || '', publicOrigin + '/api/integrations/shopee/callback'),
    tiktokCallbackExact: exactUrl(env.TIKTOK_SHOP_REDIRECT_URI || '', publicOrigin + '/api/integrations/tiktok-shop/callback'),
    tiktokApiBasePresent: Boolean(env.TIKTOK_SHOP_API_BASE_URL?.trim()),
    tiktokAuthBasePresent: Boolean(env.TIKTOK_SHOP_AUTH_BASE_URL?.trim()),
    tiktokAuthorizePresent: Boolean(env.TIKTOK_SHOP_AUTHORIZE_URL?.trim()),
  }));
  const connections = select(`SELECT provider,status,publish_mode,
    CASE WHEN auth_ciphertext IS NOT NULL AND length(auth_ciphertext)>0 THEN 1 ELSE 0 END AS hasCredentials,
    CASE WHEN external_account_id IS NOT NULL AND length(external_account_id)>0 THEN 1 ELSE 0 END AS hasExternalAccount,
    CASE WHEN last_error IS NOT NULL AND length(last_error)>0 THEN 1 ELSE 0 END AS hasLastError,
    token_expires_at,last_verified_at,last_synced_at
    FROM channel_connections WHERE workspace_id='${W}' AND provider IN ('shopee','tiktok_shop') ORDER BY provider,created_at`);
  console.log('COMMERCE_CONNECTIONS=' + JSON.stringify(connections));
  const states = select(`SELECT provider,COUNT(*) AS total,
    SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed,
    SUM(CASE WHEN consumed_at IS NULL AND expires_at>${Date.now()} THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN consumed_at IS NULL AND expires_at<=${Date.now()} THEN 1 ELSE 0 END) AS expired
    FROM oauth_states WHERE workspace_id='${W}' AND provider IN ('shopee','tiktok_shop') GROUP BY provider ORDER BY provider`);
  console.log('COMMERCE_OAUTH_STATES=' + JSON.stringify(states));
  console.log('COMMERCE_DIAG_OK');
} catch (error) {
  console.error(/^COMMERCE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'COMMERCE_DIAG_FAILED');
  process.exitCode = 1;
}
