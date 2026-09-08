"""Read one public TAHA SHOES Page post from 28 August for style analysis.

Credentials are decrypted only inside the running application container and are
never printed. The script is read-only and returns public post fields only.
"""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

WORKSPACE = '00000000-0000-4000-8000-000000000001'

NODE_SCRIPT = r"""
const fs = require('fs');
const { webcrypto } = require('crypto');
const env = Object.fromEntries(fs.readFileSync('/app/.dev.vars', 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^['\"]|['\"]$/g, '')];
}));
(async () => {
  const input = JSON.parse(await new Promise((resolve, reject) => { let value=''; process.stdin.on('data', c => value += c); process.stdin.on('end', () => resolve(value)); process.stdin.on('error', reject); }));
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY, 'base64url'), {name:'AES-GCM'}, false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({name:'AES-GCM', iv:Buffer.from(input.iv,'base64url'), additionalData:new TextEncoder().encode('taha-ai:integration-token:v1'), tagLength:128}, key, Buffer.from(input.ciphertext,'base64url'));
  const credentials = JSON.parse(new TextDecoder().decode(plain));
  const accessToken = typeof credentials.accessToken === 'string' ? credentials.accessToken : '';
  if (!accessToken || !input.pageId) process.exit(2);
  const version = env.META_GRAPH_API_VERSION || 'v23.0';
  for (const year of [2026, 2025, 2024]) {
    const params = new URLSearchParams({
      fields: 'id,message,created_time,permalink_url',
      since: `${year}-08-27T17:00:00Z`,
      until: `${year}-08-28T17:00:00Z`,
      limit: '25',
      access_token: accessToken,
    });
    const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(input.pageId)}/posts?${params}`, {signal:AbortSignal.timeout(20000)});
    if (!response.ok) process.exit(3);
    const root = await response.json();
    const posts = Array.isArray(root.data) ? root.data.filter(post => typeof post.message === 'string' && post.message.trim()) : [];
    if (posts.length) {
      process.stdout.write(JSON.stringify({year, posts:posts.map(post => ({id:post.id, createdTime:post.created_time, permalinkUrl:post.permalink_url, message:post.message}))}));
      return;
    }
  }
  process.stdout.write(JSON.stringify({year:null, posts:[]}));
})().catch(() => process.exit(4));
"""


def main():
    for database in Path('/var/lib/taha-ai').rglob('*.sqlite'):
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'channel_connections' not in tables:
                continue
            row = db.execute(
                "SELECT external_account_id,auth_ciphertext,auth_iv FROM channel_connections "
                "WHERE workspace_id=? AND provider='facebook' AND status='connected' ORDER BY created_at LIMIT 1",
                [WORKSPACE],
            ).fetchone()
            if not row:
                continue
            payload = json.dumps({'pageId': row['external_account_id'], 'ciphertext': row['auth_ciphertext'], 'iv': row['auth_iv']})
            result = subprocess.run(
                ['docker', 'exec', '-i', 'taha-ai', 'node', '-e', NODE_SCRIPT],
                input=payload, capture_output=True, text=True, timeout=60, check=True,
            )
            print('FACEBOOK_STYLE_SAMPLE=' + result.stdout, flush=True)
            return
    raise RuntimeError('FACEBOOK_CONNECTION_NOT_FOUND')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FACEBOOK_STYLE_SAMPLE_FAILED', file=sys.stderr)
        sys.exit(1)
