// Read-only production inspection. Never logs credentials or signs a publish request.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const W='00000000-0000-4000-8000-000000000001';
function d1(sql) {
  const raw=execFileSync('pnpm',['exec','wrangler','d1','execute','DB','--local','--persist-to=/data','--config=/app/wrangler.vps.jsonc','--json','--command',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000});
  const data=JSON.parse(raw);if(!data[0]?.success)throw Error('INSPECT_D1_FAILED');return data[0].results??[];
}
const env=Object.fromEntries(readFileSync('/app/.dev.vars','utf8').split(/\r?\n/).flatMap(line=>{const i=line.indexOf('=');return i>0?[[line.slice(0,i).trim(),line.slice(i+1).trim().replace(/^(["'])(.*)\1$/,'$2')]]:[]}));
async function main(){
  const state={backfillEnabled:env.WEBSITE_READY_BACKFILL_ENABLED==='1'};
  state.connections=d1(`SELECT id,provider,status,publish_mode,display_name,json_extract(config_json,'$.publishEndpoint') AS endpoint,CASE WHEN auth_ciphertext IS NOT NULL THEN 1 ELSE 0 END AS hasCredentials FROM channel_connections WHERE workspace_id='${W}' AND provider='website'`);
  state.jobs=d1(`SELECT j.id,j.draft_id,j.product_id,p.base_sku,j.status,j.error_code,j.external_post_id,j.external_url,j.attempt_count,j.scheduled_for,j.completed_at FROM publish_jobs j JOIN products p ON p.id=j.product_id JOIN channel_connections c ON c.id=j.connection_id WHERE j.workspace_id='${W}' AND c.provider='website' ORDER BY j.updated_at DESC LIMIT 25`);
  state.drafts=d1(`SELECT d.id,d.product_id,p.base_sku,d.target_provider,d.title,d.status,d.version,json_extract(d.platform_data_json,'$.sourceImageCount') AS sourceImages,json_extract(d.platform_data_json,'$.generatedImageCount') AS generatedImages,length(d.body) AS bodyLength FROM content_drafts d JOIN products p ON p.id=d.product_id WHERE d.workspace_id='${W}' AND d.archived_at IS NULL AND d.status='approved' ORDER BY p.base_sku,d.target_provider LIMIT 70`);
  state.product=d1(`SELECT p.id,p.base_sku,p.name,p.description,p.brand,p.category,json_extract(p.metadata_json,'$.website') AS website FROM products p WHERE p.workspace_id='${W}' AND p.base_sku='PH0027' AND p.deleted_at IS NULL`);
  console.log('WEBSITE_TRIAL_STATE='+JSON.stringify(state));
  const [connection]=d1(`SELECT external_account_id,auth_iv,auth_ciphertext FROM channel_connections WHERE workspace_id='${W}' AND provider='facebook' AND external_account_id='1015096011692783' AND status='connected'`);
  if(!connection)throw Error('REFERENCE_PAGE_UNAVAILABLE');
  const key=await webcrypto.subtle.importKey('raw',Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY,'base64url'),{name:'AES-GCM'},false,['decrypt']);
  const plain=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(connection.auth_iv,'base64url'),additionalData:new TextEncoder().encode('taha-ai:integration-token:v1'),tagLength:128},key,Buffer.from(connection.auth_ciphertext,'base64url'));
  const token=JSON.parse(new TextDecoder().decode(plain)).accessToken;
  if(!token||!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION))throw Error('REFERENCE_CONFIG_INVALID');
  const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${connection.external_account_id}/posts`);
  url.searchParams.set('fields','id,message,created_time,permalink_url');url.searchParams.set('limit','100');
  url.searchParams.set('since',String(Date.parse('2026-08-28T00:00:00+07:00')/1000));url.searchParams.set('until',String(Date.parse('2026-08-29T00:00:00+07:00')/1000));
  const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok||!Array.isArray(data.data))throw Error('REFERENCE_FACEBOOK_FAILED');
  // These are already-public Page posts, encoded only to preserve exact copy in Actions logs.
  console.log('FACEBOOK_AUG28_PUBLIC_REFERENCE_BASE64='+Buffer.from(JSON.stringify(data.data)).toString('base64url'));
  console.log('FACEBOOK_REFERENCE_HAS_MORE='+Boolean(data.paging?.next));
}
try{await main();}catch(error){console.log(/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:'WEBSITE_TRIAL_INSPECT_FAILED');process.exitCode=1;}
