// Only GETs. Credentials stay in the running VPS container.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const settings = Object.fromEntries(readFileSync("/app/.dev.vars", "utf8").split(/\r?\n/).flatMap((line) => {
  const index = line.indexOf("=");
  return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]] : [];
}));

async function main() {
  const sql = "SELECT j.status,j.external_post_id,j.payload_snapshot_json,c.external_account_id,c.auth_ciphertext,c.auth_iv FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id WHERE j.id='0569f8a5-faaf-484c-a1ac-7a4375faf1b4' AND j.workspace_id='00000000-0000-4000-8000-000000000001' AND c.provider='facebook'";
  const raw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to=/data", "--config=/app/wrangler.vps.jsonc", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  const [job] = JSON.parse(raw)[0]?.results ?? [];
  if (!job || job.status !== "published" || !/^\d+_\d+$/.test(job.external_post_id ?? "")
    || !job.external_post_id.startsWith(job.external_account_id + "_")) throw new Error("RECEIPT_NOT_PUBLISHED");
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(settings.INTEGRATION_TOKEN_ENCRYPTION_KEY, "base64url"), { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(job.auth_iv, "base64url"), additionalData: new TextEncoder().encode("taha-ai:integration-token:v1"), tagLength: 128 }, key, Buffer.from(job.auth_ciphertext, "base64url"));
  const credentials = JSON.parse(new TextDecoder().decode(decrypted));
  const version = settings.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version ?? "") || !credentials.accessToken) throw new Error("RECEIPT_CONFIG_INVALID");
  const url = new URL(`https://graph.facebook.com/${version}/${job.external_post_id}`);
  url.searchParams.set("fields", "id,permalink_url,message,created_time");
  const response = await fetch(url, { headers: { authorization: `Bearer ${credentials.accessToken}` }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  const post = await response.json();
  if (!response.ok || post.id !== job.external_post_id || !/\bPH0027\b/.test(post.message ?? "")
    || String(post.message).includes("Giá: 6xx") || !/^https:\/\/(?:www\.)?facebook\.com\//.test(post.permalink_url ?? "")) throw new Error("FACEBOOK_RECEIPT_MISMATCH");
  const snapshot = JSON.parse(job.payload_snapshot_json);
  const expectedCaption = [String(snapshot.message ?? "").trim(), (snapshot.hashtags ?? []).map(tag => "#" + String(tag).trim().replace(/^#+/, "")).join(" ")].filter(Boolean).join("\n\n");
  if (post.message !== expectedCaption) throw new Error("FACEBOOK_CAPTION_MISMATCH");
  const publicReceipt = { sku: "PH0027", postId: post.id, url: post.permalink_url, createdAt: post.created_time, images: snapshot.mediaIds?.length ?? 0, captionMatches: true };
  console.log("FACEBOOK_VERIFIED_RECEIPT_BASE64=" + Buffer.from(JSON.stringify(publicReceipt), "utf8").toString("base64url"));
  const ui = await fetch("http://127.0.0.1:8787/calendar", { headers: { authorization: `Bearer ${settings.INTERNAL_API_SECRET}` }, signal: AbortSignal.timeout(15000) });
  const html = await ui.text();
  const pendingSql = "SELECT j.id,j.status,c.provider,c.publish_mode FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id WHERE j.workspace_id='00000000-0000-4000-8000-000000000001' AND c.provider='zalo_personal' ORDER BY j.updated_at DESC LIMIT 10";
  const pendingRaw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to=/data", "--config=/app/wrangler.vps.jsonc", "--json", "--command", pendingSql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  const zaloJobs = JSON.parse(pendingRaw)[0]?.results ?? [];
  const awaiting = zaloJobs.filter(job => job.status === "awaiting_confirmation");
  console.log("DEPLOYED_CALENDAR_STATE=" + JSON.stringify({ httpStatus:ui.status,heading:html.includes("Tác vụ cần theo dõi"),manualAction:html.includes("Mở đúng bài để sao chép và tự đăng"),zaloJobs }));
  if (!ui.ok || !html.includes("Tác vụ cần theo dõi")
    || (awaiting.length > 0 && !awaiting.some(job => html.includes("job=" + encodeURIComponent(job.id))))) throw new Error("CALENDAR_ACTION_VERIFY_FAILED");
  console.log("DEPLOYED_CALENDAR_ACTION_VERIFIED=yes");
}

try { await main(); }
catch (error) { console.log(/^[A-Z][A-Z0-9_]+$/.test(error.message ?? "") ? error.message : "FACEBOOK_VERIFY_FAILED"); process.exitCode = 1; }
