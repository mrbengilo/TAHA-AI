// Read-only production diagnosis. Tokens are decrypted and used only inside the VPS container.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const settings = Object.fromEntries(readFileSync("/app/.dev.vars", "utf8").split(/\r?\n/).flatMap((line) => {
  const index = line.indexOf("=");
  return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]] : [];
}));
const hidden = [];
const safe = (value) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, String(value ?? "")).slice(0, 500);
function report(label, value) { console.log(label + "=" + JSON.stringify(value)); }
function query(sql) {
  const raw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to=/data", "--config=/app/wrangler.vps.jsonc", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  return JSON.parse(raw)[0]?.results ?? [];
}
async function main() {
  const policyModule = { exports: {} };
  const compiled = ts.transpileModule(readFileSync('/app/lib/ai/shoe-content.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new vm.Script(compiled).runInContext(vm.createContext({ module: policyModule, exports: policyModule.exports }));
  const failures = query("SELECT j.id,j.payload_snapshot_json,d.id AS draft_id,d.version,d.title,d.body,d.hashtags_json,p.base_sku FROM publish_jobs j JOIN content_drafts d ON d.id=j.draft_id JOIN products p ON p.id=j.product_id WHERE j.workspace_id='00000000-0000-4000-8000-000000000001' AND j.error_code='CONTENT_PRICE_FORBIDDEN'");
  report('PRICE_BLOCK_DETAILS', failures.map((row) => {
    const payload = JSON.parse(row.payload_snapshot_json);
    return { jobId: row.id, draftId: row.draft_id, version: row.version, sku: row.base_sku,
      offendingLines: [payload.title ?? '', payload.message ?? '', ...(payload.hashtags ?? [])].join('\n').split('\n').filter(line => policyModule.exports.hasPriceDisclosure(line)),
      offendingInternalLines: [row.title ?? '', row.body ?? '', ...JSON.parse(row.hashtags_json)].join('\n').split('\n').filter(line => policyModule.exports.hasForbiddenInternalText(line)),
      currentDraftViolation: policyModule.exports.customerCopyViolation({title: row.title, body: row.body, hashtags: JSON.parse(row.hashtags_json)}) };
  }));
  const [connection] = query("SELECT external_account_id,display_name,status,publish_mode,config_json,auth_ciphertext,auth_iv FROM channel_connections WHERE workspace_id='00000000-0000-4000-8000-000000000001' AND provider='facebook' AND status='connected' ORDER BY updated_at DESC LIMIT 1");
  if (!connection || !/^\d+$/.test(connection.external_account_id)) throw new Error("TRIAL_FACEBOOK_CONNECTION_INVALID");
  const pageId = connection.external_account_id;
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(settings.INTEGRATION_TOKEN_ENCRYPTION_KEY, "base64url"), { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(connection.auth_iv, "base64url"), additionalData: new TextEncoder().encode("taha-ai:integration-token:v1"), tagLength: 128 }, key, Buffer.from(connection.auth_ciphertext, "base64url"));
  const credentials = JSON.parse(new TextDecoder().decode(decrypted));
  const token = credentials.accessToken;
  if (typeof token !== "string" || !token) throw new Error("FACEBOOK_TOKEN_MISSING");
  const appToken = settings.META_APP_ID && settings.META_APP_SECRET ? `${settings.META_APP_ID}|${settings.META_APP_SECRET}` : null;
  hidden.push(token, settings.META_APP_SECRET, appToken);
  const version = settings.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version ?? "")) throw new Error("FACEBOOK_API_VERSION_INVALID");
  report("FACEBOOK_CONNECTION", { pageId, name: connection.display_name, status: connection.status, mode: connection.publish_mode, configuredTasks: JSON.parse(connection.config_json || "{}").tasks ?? [] });

  async function graph(label, path, params = {}, bearer = token) {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    try {
      const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${bearer}` }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const data = await response.json().catch(() => null);
      const error = data?.error;
      report(label, { http: response.status, contentType: response.headers.get("content-type"), ...(error ? { error: { code: error.code, subcode: error.error_subcode, type: error.type, message: safe(error.message), transient: error.is_transient } } : {}) });
      return response.ok ? data : null;
    } catch { report(label, { transportError: true }); return null; }
  }
  const identity = await graph("FACEBOOK_IDENTITY_HTTP", "me", { fields: "id,name" });
  if (identity) report("FACEBOOK_IDENTITY", { matchesConfiguredPage: identity.id === pageId });
  const page = await graph("FACEBOOK_PAGE_HTTP", pageId, { fields: "id,name" });
  if (page) report("FACEBOOK_PAGE", { matchesConfiguredPage: page.id === pageId, name: page.name });
  if (appToken) {
    const debug = await graph("FACEBOOK_TOKEN_DEBUG_HTTP", "debug_token", { input_token: token }, appToken);
    if (debug?.data) {
      const data = debug.data;
      report("FACEBOOK_TOKEN_DEBUG", { valid: data.is_valid, type: data.type, appMatches: data.app_id === settings.META_APP_ID, profileMatchesPage: data.profile_id ? data.profile_id === pageId : null, expiresAt: data.expires_at, dataAccessExpiresAt: data.data_access_expires_at, scopes: data.scopes, granularScopes: (data.granular_scopes ?? []).map((item) => ({ scope: item.scope, includesConfiguredPage: (item.target_ids ?? []).includes(pageId) })) });
    }
  }
  const posts = await graph("FACEBOOK_RECENT_POSTS_HTTP", `${pageId}/published_posts`, { fields: "id,permalink_url,message,created_time", limit: 30 });
  if (Array.isArray(posts?.data)) report("FACEBOOK_MATCHING_RECENT_POSTS", posts.data.map((post) => ({ id: post.id, url: post.permalink_url, createdAt: post.created_time, skus: [...new Set(String(post.message ?? "").match(/\bPH\d{4}\b/g) ?? [])] })));
}

try { await main(); } catch (error) { report("FACEBOOK_DIAGNOSE_FAILED", { code: /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : "DIAGNOSTIC_FAILED" }); process.exitCode = 1; }
