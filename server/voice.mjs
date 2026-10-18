import { localVoiceExtractor } from './local-voice.mjs';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const fail = (message, status=400) => Object.assign(new Error(message), {status});
const cosine=(a,b)=>a.length===b.length?a.reduce((n,x,i)=>n+x*b[i],0)/Math.sqrt(a.reduce((n,x)=>n+x*x,0)*b.reduce((n,x)=>n+x*x,0)):-1;
const id=v=>typeof v==='string' && /^[a-zA-Z0-9_-]{1,120}$/.test(v);
const TTL=2*60*60*1000;
// Adapter contract is documented separately. No vendor endpoint is assumed.
export function createVoiceService(env, fetchImpl=fetch) {
  const localMode=env.VOICE_PROVIDER==='local', local=localMode?localVoiceExtractor(env):null;
  let runtimeReady=!localMode;
  const sessions=new Map(), ended=new Map(), locks=new Map();
  const threshold=Number(env.VOICE_MATCH_THRESHOLD), margin=Number(env.VOICE_MATCH_MARGIN), novel=Number(env.VOICE_NEW_THRESHOLD);
  const key=/^[a-f0-9]{64}$/i.test(env.VOICE_STORE_KEY || '')?Buffer.from(env.VOICE_STORE_KEY,'hex'):null;
  let base;try{base=new URL(env.VOICE_EXTRACT_URL);}catch{}
  const secure=base && (base.protocol==='https:' || base.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname)) && !base.username && !base.password && !base.search && !base.hash;
  const configured=!!((localMode?local.configured:secure && env.VOICE_API_KEY) && env.VOICE_MODEL && env.VOICE_STORE_DIR && key && threshold>0 && threshold<1 && margin>0 && margin<1 && novel>=-1 && novel<threshold-margin && env.VOICE_CALIBRATION_ID);
  const verified=env.VOICE_VERIFIED==='true', preview=env.VOICE_PREVIEW==='true';
  const enabled=configured && (verified || preview);
  const isReady=()=>enabled && runtimeReady;
  const dir=env.VOICE_STORE_DIR?resolve(env.VOICE_STORE_DIR):null;
  const owner=token=>createHash('sha256').update(token || 'loopback-development').digest('hex');
  const hostPath=who=>join(dir,who+'.json.enc');
  const status=()=>({configured,ready:isReady(),preview:!verified && preview,provider:localMode?'local-cpu':'http-extractor',model:configured?env.VOICE_MODEL:null,reason:!configured?'声音服务尚未配置，请完成服务端配置。':!enabled?'声音模型待校准，请管理员启用验证。':!runtimeReady?'本地声音模型未就绪，请检查运行环境。':!verified?'开发预览：真实设备效果尚待校准，请依次单独讲话。':'',scope:'依次单人讲话；不承诺重叠讲话识别',temporaryRetention:'结束即删除；未正常结束时最后活动起两小时自动清理；服务重启即丢失临时特征。'});
  const sweep=()=>{const now=Date.now();for(const [k,s]of sessions)if(s.expires<=now)sessions.delete(k);for(const [k,t]of ended)if(t<=now)ended.delete(k);};
  const timer=setInterval(sweep,60000);timer.unref();
  async function host(who) {
    if(!dir || !key)return null;
    try {
      const bytes=await readFile(hostPath(who)), decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    }catch(e){if(e.code==='ENOENT')return null;throw fail('主持人声音档案读取失败，请检查存储配置。',503);}
  }
  async function extract(sample,signal) {
    if(localMode)runtimeReady=await local.probe();
    if(!isReady())throw fail(status().reason,503);
    if(!sample || !['ogg','pcm'].includes(sample.format) || sample.rate!==16000 || sample.channel!==1 || !Number.isFinite(sample.durationMs) || sample.durationMs<2000 || sample.durationMs>30000 || typeof sample.data!=='string' || sample.data.length>1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sample.data))throw fail('声音采样格式、时长或大小无效。');
    const bytes=Buffer.from(sample.data,'base64');
    if(sample.format==='ogg' && bytes.subarray(0,4).toString()!=='OggS' || sample.format==='pcm' && Math.abs(bytes.length-sample.durationMs*32)>1280)throw fail('声音编码与采样时长不符。');
    let response, v;
    if(localMode){v=await local.extract(sample,signal);} else {
    try{response=await fetchImpl(base.href,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.VOICE_API_KEY}`},body:JSON.stringify({model:env.VOICE_MODEL,audio:sample}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error'});}catch{throw fail('声纹服务连接失败，未更新档案。',502);}
    if(!response.ok)throw fail('声纹服务请求失败，未更新档案。',502);
    try{const text=await response.text();if(text.length>100000)throw Error();v=JSON.parse(text);}catch{throw fail('声纹服务结果无效。',502);}
    }
    if(v.model!==env.VOICE_MODEL || !Array.isArray(v.embedding) || v.embedding.length<16 || v.embedding.length>2048 || v.embedding.some(x=>!Number.isFinite(x)) || !v.embedding.some(x=>x!==0))throw fail('声纹特征或模型版本无效。',502);
    // Quality must be measured by the extractor, not inferred from ASR text.
    if(v.quality?.singleSpeaker!==true || (localMode?v.quality?.scope!=='sequential-speech':v.quality?.overlap!==false) || v.quality?.usable!==true || !Number.isFinite(v.quality?.speechMs) || v.quality.speechMs<2000 || v.quality.speechMs>sample.durationMs+40)throw fail('声音不足、噪声或重叠讲话，请单独连续讲话后重试。',422);
    return {embedding:v.embedding,model:v.model};
  }
  async function handle(action,input,token,signal) {
    sweep();const who=owner(token);
    const lockKey=who;
    const previous=locks.get(lockKey)||Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      if(action==='status') {if(localMode)runtimeReady=await local.probe();const h=await host(who);return {...status(),host:{registered:!!h && h.model===env.VOICE_MODEL,model:h?.model || null}};}
      if(action==='delete-host') {if(dir)try{await unlink(hostPath(who));}catch(e){if(e.code!=='ENOENT')throw fail('删除主持人声音失败。',503);}for(const [k,s]of sessions)if(s.owner===who)sessions.delete(k);return {deleted:true};}
      if(action==='enroll') {
        if(input.consent!==true)throw fail('请先同意采集主持人声音。');
        const profile=await extract(input.sample,signal);signal?.throwIfAborted();
        await mkdir(dir,{recursive:true});const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
        const body=Buffer.concat([cipher.update(JSON.stringify({...profile,createdAt:new Date().toISOString()})),cipher.final()]);
        const path=hostPath(who),tmp=path+'.'+randomUUID()+'.tmp';
        try{await writeFile(tmp,Buffer.concat([iv,cipher.getAuthTag(),body]),{mode:0o600,flag:'wx'});signal?.throwIfAborted();await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}
        for(const [k,s]of sessions)if(s.owner===who)sessions.delete(k);
        return {registered:true,model:profile.model};
      }
      if(!id(input.sessionId))throw fail('访谈编号无效。');
      const sessionKey=who+':'+input.sessionId;
      if(action==='end'){sessions.delete(sessionKey);ended.set(sessionKey,Date.now()+TTL);return {cleared:true};}
      if(!id(input.segmentId) || !id(input.streamId) || !Number.isInteger(input.expectedGuests) || input.expectedGuests<1 || input.expectedGuests>5 || !['opening','formal'].includes(input.phase))throw fail('人物匹配上下文无效。');
      if(ended.has(sessionKey))throw fail('本场声音档案已清理，请新建访谈。',409);
      const h=await host(who);if(!h || h.model!==env.VOICE_MODEL)throw fail('请先注册当前模型的主持人声音。',409);
      let s=sessions.get(sessionKey);
      // Reusing saved guest IDs after restart/expiry requires new introductions.
      if(!s && (input.phase==='formal' || input.hasKnownGuests===true))return {segmentId:input.segmentId,streamId:input.streamId,reason:'临时声音档案已过期或服务重启，请结束并新建访谈重新采集；本场旧人物标签保留。',needsOpening:true};
      const feature=await extract(input.sample,signal);signal?.throwIfAborted();
      if(!s){if(sessions.size>=100)throw fail('声纹服务会话已满，请稍后重试。',429);s={owner:who,people:[{id:input.sessionId+':host',role:'host',...h}],expires:Date.now()+TTL};sessions.set(sessionKey,s);}
      s.expires=Date.now()+TTL;
      const shortReply=typeof input.text==='string' && /^(嗯|啊|哦|好|对|是的|好的|对的|谢谢|你好)+$/.test(input.text.replace(/[\s，。！？、,.!?]/g,''));
      if(shortReply)return {segmentId:input.segmentId,streamId:input.streamId,participant:null,reason:'简短应答暂不建立人物档案，请补充连续讲话。'};
      const ranked=s.people.map(p=>({p,score:cosine(feature.embedding,p.embedding)})).sort((a,b)=>b.score-a.score);
      let p,reason='样本不足或候选接近，请补充单人讲话。';
      if(ranked[0].score>=threshold && ranked[0].score-(ranked[1]?.score ?? -1)>=margin)p=ranked[0].p;
      else if(ranked[0].score<novel && (input.phase==='opening' || input.allowNewGuest===true && s.people.filter(p=>p.role==='guest').length<input.expectedGuests) && s.people.filter(p=>p.role==='guest').length<5){p={id:input.sessionId+':'+randomUUID(),role:'guest',...feature};s.people.push(p);}
      else if(input.phase==='opening' && s.people.filter(p=>p.role==='guest').length>=5)reason='已达到五位嘉宾上限，请核对未知声音。';
      return {segmentId:input.segmentId,streamId:input.streamId,participant:p?{id:p.id,role:p.role}:null,reason:p?'':reason};
    });
    locks.set(lockKey,work);try{return await work;}finally{if(locks.get(lockKey)===work)locks.delete(lockKey);}
  }
  return {status,handle,close(){clearInterval(timer);sessions.clear();ended.clear();}};
}
