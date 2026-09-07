// Edit only the existing, user-authorized PH0014 post. Never create a post.
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const TARGET = Object.freeze({
  workspaceId: "00000000-0000-4000-8000-000000000001",
  jobId: "6ab6e1fc-1a05-4b6f-8053-565b94bd9481",
  productId: "f71003d5-0009-42d8-8ea2-d94496fa3758",
  pageId: "1015096011692783",
  postId: "1015096011692783_122121496239193948",
});
const INTERNAL_PARAGRAPH = "Vui lòng kiểm tra đúng mã sản phẩm PH0014 và thương hiệu LITUO SPORT trước khi mua. Hình ảnh sản phẩm sử dụng ảnh có sẵn từ Google Drive.";
const fail = (code) => { throw new Error(code); };
const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function cleanTrialCopy(value) {
  if (typeof value !== "string" || !value.includes("PH0014")) fail("CORRECTION_COPY_INVALID");
  const clean = value.replace(INTERNAL_PARAGRAPH, "")
    .split(/\r?\n/).filter((line) => !/^\s*[•*\-]?\s*Giá (bán|tham khảo):\s*[\d., ]+\s*VND\s*$/iu.test(line))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (/Google Drive|Vui lòng kiểm tra đúng mã|\bVND\b|Giá (bán|tham khảo)/iu.test(clean)) fail("CORRECTION_COPY_STILL_INVALID");
  return clean;
}

export function checkTarget(row) {
  if (!row || row.id !== TARGET.jobId || row.workspace_id !== TARGET.workspaceId
    || row.product_id !== TARGET.productId || row.status !== "published"
    || row.external_post_id !== TARGET.postId || row.page_id !== TARGET.pageId
    || row.provider !== "facebook" || row.connection_status !== "connected"
    || row.draft_product_id !== TARGET.productId || row.target_provider !== "facebook") fail("CORRECTION_TARGET_MISMATCH");
  const payload = JSON.parse(row.payload_snapshot_json);
  if (payload.productId !== TARGET.productId || payload.draftId !== row.draft_id
    || payload.provider !== "facebook" || !Array.isArray(payload.hashtags)) fail("CORRECTION_PAYLOAD_MISMATCH");
  const tags = payload.hashtags.map((tag) => `#${String(tag).replace(/^#+/, "")}`).join(" ");
  const before = [String(payload.message).trim(), tags].filter(Boolean).join("\n\n");
  const after = cleanTrialCopy(before);
  const draftAfter = cleanTrialCopy(payload.message);
  if (row.body !== payload.message && row.body !== draftAfter) fail("CORRECTION_DRAFT_CHANGED");
  if (JSON.stringify(JSON.parse(row.hashtags_json)) !== JSON.stringify(payload.hashtags)) fail("CORRECTION_DRAFT_CHANGED");
  return { before, after, draftAfter };
}

function d1(sql) {
  let parsed;
  try {
    const raw = execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--persist-to=/data",
      "--config=/app/wrangler.vps.jsonc", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
    parsed = JSON.parse(raw);
  } catch { fail("CORRECTION_DATABASE_FAILED"); }
  if (!Array.isArray(parsed) || !parsed[0]?.success) fail("CORRECTION_DATABASE_FAILED");
  return parsed[0].results ?? [];
}

async function main() {
  const rows = d1(`SELECT j.id,j.workspace_id,j.product_id,j.draft_id,j.status,j.external_post_id,j.payload_snapshot_json,
    c.external_account_id AS page_id,c.provider,c.status AS connection_status,c.auth_iv,c.auth_ciphertext,
    d.product_id AS draft_product_id,d.target_provider,d.body,d.version,d.hashtags_json
    FROM publish_jobs j JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id
    JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id
    WHERE j.id=${quoted(TARGET.jobId)} AND j.workspace_id=${quoted(TARGET.workspaceId)} LIMIT 2`);
  if (rows.length !== 1) fail("CORRECTION_TARGET_MISMATCH");
  const row = rows[0];
  const copy = checkTarget(row);
  const env = Object.fromEntries(readFileSync("/app/.dev.vars", "utf8").split(/\r?\n/).flatMap((line) => {
    const i = line.indexOf("=");
    return i > 0 ? [[line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]] : [];
  }));
  let token;
  try {
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY, "base64url"), { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(row.auth_iv, "base64url"),
      additionalData: new TextEncoder().encode("taha-ai:integration-token:v1"), tagLength: 128 }, key, Buffer.from(row.auth_ciphertext, "base64url"));
    token = JSON.parse(new TextDecoder().decode(plain)).accessToken;
  } catch { fail("CORRECTION_TOKEN_UNAVAILABLE"); }
  if (typeof token !== "string" || !token) fail("CORRECTION_TOKEN_UNAVAILABLE");
  const version = env.META_GRAPH_API_VERSION || "v26.0";
  if (!/^v\d+\.\d+$/.test(version)) fail("CORRECTION_API_VERSION_INVALID");
  const url = new URL(`https://graph.facebook.com/${version}/${TARGET.postId}`);
  async function graph(method = "GET", message) {
    const endpoint = new URL(url);
    if (method === "GET") endpoint.searchParams.set("fields", "id,message,permalink_url");
    const response = await fetch(endpoint, { method, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: new URLSearchParams({ message }) } : {}) });
    if (!response.ok || response.status >= 300) fail(`CORRECTION_FACEBOOK_HTTP_${response.status}`);
    const result = await response.json();
    if (!result || result.error) fail("CORRECTION_FACEBOOK_FAILED");
    return result;
  }
  const current = await graph();
  if (current.id !== TARGET.postId || ![copy.before, copy.after].includes(current.message)) fail("CORRECTION_POST_CHANGED");
  console.log("FACEBOOK_CORRECTION_PREFLIGHT=EXACT_PUBLISHED_POST");
  if (!process.argv.includes("--apply")) return;
  if (current.message !== copy.after) {
    mkdirSync("/data/ops-recovery", { recursive: true, mode: 0o700 });
    const path = `/data/ops-recovery/facebook-correction-${TARGET.postId}-v1.json`;
    const backup = { postId: TARGET.postId, before: copy.before, after: copy.after, draftId: row.draft_id };
    try { writeFileSync(path, JSON.stringify(backup), { flag: "wx", mode: 0o600, flush: true }); }
    catch (error) {
      if (error.code !== "EEXIST" || JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(backup)) fail("CORRECTION_BACKUP_FAILED");
    }
    const result = await graph("POST", copy.after);
    if (result.success !== true) fail("CORRECTION_FACEBOOK_NOT_CONFIRMED");
  }
  const verified = await graph();
  if (verified.id !== TARGET.postId || verified.message !== copy.after) fail("CORRECTION_VERIFY_FAILED");
  if (row.body !== copy.draftAfter) {
    const updated = d1(`UPDATE content_drafts SET body=${quoted(copy.draftAfter)},version=version+1,updated_at=${Date.now()}
      WHERE id=${quoted(row.draft_id)} AND workspace_id=${quoted(TARGET.workspaceId)} AND product_id=${quoted(TARGET.productId)}
      AND version=${Number(row.version)} AND body=${quoted(row.body)} AND target_provider='facebook' RETURNING id`);
    if (updated.length !== 1 || updated[0].id !== row.draft_id) fail("CORRECTION_DRAFT_CAS_LOST");
  }
  console.log("FACEBOOK_CORRECTION_VERIFIED=PRICES_AND_INTERNAL_PARAGRAPH_REMOVED");
  console.log("FACEBOOK_CORRECTION_POST_ID=" + TARGET.postId);
}

if (process.argv.includes("--run")) main().catch((error) => {
  console.error(/^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message) ? error.message : "CORRECTION_FAILED");
  process.exitCode = 1;
});
