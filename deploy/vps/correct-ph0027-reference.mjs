// User-authorized correction of one existing Facebook post; never creates a post.
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const T={workspace:'00000000-0000-4000-8000-000000000001',job:'0569f8a5-faaf-484c-a1ac-7a4375faf1b4',product:'7e1f7049-0459-4b9c-85b0-ecc2930f9472',draft:'draft_ab03ca69262f4408be0858cee3cea2ca2c96d044',page:'1015096011692783',post:'1015096011692783_122121591513193948'};
const title='🤍 LITUO SPORT PH0027 – PHỐI MÀU NHẸ NHÀNG, PHONG CÁCH NĂNG ĐỘNG! 🤍';
const body=`${title}

📍 Thiết kế: Tông kem sáng phối các chi tiết pastel, kết hợp dáng sneaker thể thao hiện đại. Tổng thể nhẹ nhàng nhưng vẫn có điểm nhấn, dễ kết hợp với trang phục năng động hằng ngày.
📍 Ưu điểm: Lituo Sport PH0027 hướng đến sự thoải mái và tự tin khi sử dụng. Phong cách dễ phối giúp bạn linh hoạt thay đổi trang phục mà vẫn giữ được vẻ trẻ trung, gọn gàng.
📍 Ứng dụng: Phù hợp để hoàn thiện những bộ đồ đi học, đi làm hoặc dạo phố. Phối cùng quần jeans, quần thể thao hay trang phục thường ngày để tạo nét riêng cho phong cách của bạn.

🔰 Size: 36, 37, 38, 39, 40
🔰 Màu: Tông kem sáng phối chi tiết pastel như hình sản phẩm.
🔰 Mã sản phẩm: PH0027
────────────────────
🎁 QUÀ TẶNG KHI MUA TẠI TAHA SHOES
• 1 chai khử mùi giày + 1 đôi vớ thể thao.
• Sản phẩm được đóng gói kỹ với bọc chống sốc và hộp bảo vệ.
• Cần hỗ trợ về sản phẩm hoặc dịch vụ? Liên hệ 0765.109.784 để TAHA SHOES hỗ trợ bạn.
────────────────────
🛡️ CAM KẾT & CHÍNH SÁCH
👉 TAHA SHOES cam kết mang sản phẩm chất lượng đến tay khách hàng.
👉 Bảo hành 12 tháng.
👉 Miễn phí giao hàng toàn quốc.
👉 Đổi size miễn phí trong 7 ngày.
👉 Được kiểm tra hàng trước khi nhận.
👉 Nhận hàng trước, thanh toán sau.
────────────────────
THÔNG TIN LIÊN HỆ
📞 Hotline: 0765.109.784
📲 Zalo: 0765.109.784 (TAHA SHOES)
📌 Facebook: TAHA SHOES
🌐 Website: tahashoes.vn
❤️ TikTok: tiktok.com/@tahashoes.vn
🧡 Shopee: https://shopee.vn/bengilo#product_list`;
const hashtags=['giaythethao','LituoSport','sneaker','giaydihoc','giaydibo','TAHASHOES','PH0027'];
const after=body+'\n\n'+hashtags.map(x=>'#'+x).join(' ');
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
const fail=c=>{throw Error(c)};
function d1(sql){const r=JSON.parse(execFileSync('pnpm',['exec','wrangler','d1','execute','DB','--local','--persist-to=/data','--config=/app/wrangler.vps.jsonc','--json','--command',sql],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}));if(!r[0]?.success)fail('COPY_DATABASE_FAILED');return r[0].results??[];}
async function main(){
 const [row]=d1(`SELECT j.*,d.body,d.title,d.version,d.hashtags_json,d.platform_data_json,d.product_id AS draft_product_id,p.base_sku,p.metadata_json,c.external_account_id,c.auth_iv,c.auth_ciphertext,c.status AS connection_status,c.provider FROM publish_jobs j JOIN content_drafts d ON d.id=j.draft_id AND d.workspace_id=j.workspace_id JOIN products p ON p.id=j.product_id AND p.workspace_id=j.workspace_id JOIN channel_connections c ON c.id=j.connection_id AND c.workspace_id=j.workspace_id WHERE j.id=${q(T.job)} AND j.workspace_id=${q(T.workspace)}`);
 if(!row||row.status!=='published'||row.external_post_id!==T.post||row.external_account_id!==T.page||row.provider!=='facebook'||row.connection_status!=='connected'||row.product_id!==T.product||row.draft_product_id!==T.product||row.draft_id!==T.draft||row.base_sku!=='PH0027')fail('COPY_TARGET_CHANGED');
 if(JSON.stringify(JSON.parse(row.metadata_json).website?.sizes)!==JSON.stringify(['36','37','38','39','40']))fail('COPY_SIZES_CHANGED');
 const snapshot=JSON.parse(row.payload_snapshot_json);
 if(snapshot.productId!==T.product||snapshot.draftId!==T.draft||snapshot.provider!=='facebook'||!Array.isArray(snapshot.hashtags)||!Array.isArray(snapshot.mediaIds)||snapshot.mediaIds.length!==3)fail('COPY_SNAPSHOT_CHANGED');
 const before=[String(snapshot.message).trim(),snapshot.hashtags.map(x=>'#'+String(x).replace(/^#+/,'')).join(' ')].filter(Boolean).join('\n\n');
 const draftMatchesSnapshot=row.body===snapshot.message&&JSON.stringify(JSON.parse(row.hashtags_json))===JSON.stringify(snapshot.hashtags);
 const draftAlreadyCorrect=row.body===body&&row.title===title&&JSON.stringify(JSON.parse(row.hashtags_json))===JSON.stringify(hashtags);
 if(!draftMatchesSnapshot&&!draftAlreadyCorrect)fail('COPY_DRAFT_SNAPSHOT_DIVERGED');
 if(body.match(/PH\d{4}/g)?.some(sku=>sku!=='PH0027')||body.split(/\s+/).length>2000)fail('COPY_TEXT_INVALID');
 const env=Object.fromEntries(readFileSync('/app/.dev.vars','utf8').split(/\r?\n/).flatMap(line=>{const i=line.indexOf('=');return i>0?[[line.slice(0,i).trim(),line.slice(i+1).trim().replace(/^(["'])(.*)\1$/,'$2')]]:[]}));
 const key=await webcrypto.subtle.importKey('raw',Buffer.from(env.INTEGRATION_TOKEN_ENCRYPTION_KEY,'base64url'),{name:'AES-GCM'},false,['decrypt']);
 const plain=await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(row.auth_iv,'base64url'),additionalData:new TextEncoder().encode('taha-ai:integration-token:v1'),tagLength:128},key,Buffer.from(row.auth_ciphertext,'base64url'));
 const token=JSON.parse(new TextDecoder().decode(plain)).accessToken;
 if(!token||!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION))fail('COPY_AUTH_UNAVAILABLE');
 const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${T.post}`);
 async function graph(method='GET'){
  const endpoint=new URL(url);if(method==='GET')endpoint.searchParams.set('fields','id,message,permalink_url');
  const r=await fetch(endpoint,{method,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`,...(method==='POST'?{'content-type':'application/x-www-form-urlencoded'}:{})},...(method==='POST'?{body:new URLSearchParams({message:after})}:{})});
  const data=await r.json();if(!r.ok||data.error)fail('COPY_FACEBOOK_FAILED');return data;
 }
 const current=await graph();if(current.id!==T.post||![before,after].includes(current.message))fail('COPY_REMOTE_CHANGED');
 const path=`/data/ops-recovery/ph0027-aug28-copy-v1.json`;
 mkdirSync('/data/ops-recovery',{recursive:true,mode:0o700});
 let backup;
 try{backup=JSON.parse(readFileSync(path,'utf8'));if(backup.postId!==T.post||backup.after!==after)fail('COPY_BACKUP_CHANGED');}
 catch(error){if(error.code!=='ENOENT')throw error;backup={postId:T.post,before,after,draftId:T.draft,draftVersion:row.version,payload:row.payload_snapshot_json};writeFileSync(path,JSON.stringify(backup),{flag:'wx',mode:0o600,flush:true});}
 if(current.message!==after){const result=await graph('POST');if(result.success!==true)fail('COPY_UPDATE_NOT_CONFIRMED');}
 const verified=await graph();if(verified.id!==T.post||verified.message!==after)fail('COPY_VERIFY_FAILED');
 if(row.body!==body||snapshot.message!==body){
  const platform={...JSON.parse(row.platform_data_json),productDescription:body};
  const nextVersion=row.body===body?row.version:row.version+1;
  const next={...snapshot,title,message:body,hashtags,draftVersion:nextVersion,platformData:platform};
  if(row.body!==body){
    const updated=d1(`UPDATE content_drafts SET title=${q(title)},body=${q(body)},hashtags_json=${q(JSON.stringify(hashtags))},platform_data_json=${q(JSON.stringify(platform))},version=version+1,updated_at=${Date.now()} WHERE id=${q(T.draft)} AND workspace_id=${q(T.workspace)} AND product_id=${q(T.product)} AND version=${row.version} AND body=${q(row.body)} RETURNING id`);
    if(updated.length!==1)fail('COPY_DRAFT_CONFLICT');
  }
  const jobs=d1(`UPDATE publish_jobs SET payload_snapshot_json=${q(JSON.stringify(next))},updated_at=${Date.now()} WHERE id=${q(T.job)} AND workspace_id=${q(T.workspace)} AND status='published' AND external_post_id=${q(T.post)} AND payload_snapshot_json=${q(row.payload_snapshot_json)} RETURNING id`);
  if(jobs.length!==1)fail('COPY_JOB_CONFLICT');
  d1(`INSERT OR IGNORE INTO audit_logs(id,workspace_id,actor_type,actor_id,actor_label,action,entity_type,entity_id,metadata_json,created_at) VALUES('ph0027-aug28-copy-v1',${q(T.workspace)},'system','operator','Operator correction','content.published_copy_corrected','publish_job',${q(T.job)},${q(JSON.stringify({postId:T.post,referencePostId:'1015096011692783_122120254731193948',previousVersion:backup.draftVersion,version:nextVersion,mediaUnchanged:true}))},${Date.now()})`);
 }
 const [final]=d1(`SELECT d.body,j.payload_snapshot_json FROM publish_jobs j JOIN content_drafts d ON d.id=j.draft_id WHERE j.id=${q(T.job)} AND j.workspace_id=${q(T.workspace)}`);
 if(final.body!==body||JSON.parse(final.payload_snapshot_json).message!==body)fail('COPY_PERSISTENCE_VERIFY_FAILED');
 console.log('PH0027_COPY_VERIFIED_BASE64='+Buffer.from(JSON.stringify({postId:T.post,url:verified.permalink_url,characters:body.length,template:'TAHA SHOES 28/08/2026',samePost:true,mediaUnchanged:true})).toString('base64url'));
}
try{await main();}catch(error){console.log(/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:'COPY_CORRECTION_FAILED');process.exitCode=1;}
