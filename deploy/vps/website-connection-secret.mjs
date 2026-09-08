// Private stdout only: MUST be captured by website-runtime-repair.py, never run in logs.
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

async function main() {
  const env = parseEnv(readFileSync('/app/.dev.vars', 'utf8'));
  const sql = "SELECT provider,status,publish_mode,config_json,auth_iv,auth_ciphertext FROM channel_connections WHERE id='de367230-7460-4964-ba4c-5754819efce6' AND workspace_id='00000000-0000-4000-8000-000000000001'";
  const data = JSON.parse(execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local',
    '--persist-to=/data', '--config=/app/wrangler.vps.jsonc', '--json', '--command', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }));
  if (data.length !== 1 || !data[0]?.success || data[0].results?.length !== 1) throw Error();
  const row = data[0].results[0];
  if (row.provider !== 'website' || row.status !== 'connected' || row.publish_mode !== 'api'
      || JSON.parse(row.config_json).publishEndpoint !== 'https://tahashoes.vn/api/taha/publish') throw Error();
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY, 'base64url'),
    { name: 'AES-GCM' }, false, ['decrypt']);
  const raw = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.auth_iv, 'base64url'),
    additionalData: new TextEncoder().encode('taha-ai:integration-token:v1'), tagLength: 128 },
  key, Buffer.from(row.auth_ciphertext, 'base64url'));
  const secret = JSON.parse(new TextDecoder().decode(raw)).webhookSecret;
  if (typeof secret !== 'string' || secret.length < 24 || secret.length > 512
      || /[^\x21-\x7e]|['\\]/.test(secret)) throw Error();
  process.stdout.write(secret);
}

try { await main(); } catch { process.stderr.write('WEBSITE_CONNECTION_SECRET_UNAVAILABLE\n'); process.exitCode = 1; }
