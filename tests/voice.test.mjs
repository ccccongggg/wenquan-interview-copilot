import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createVoiceService } from '../server/voice.mjs';
import { createService } from '../server/service.mjs';
import { newTopic, addSegment, exportMarkdown, correctSegment } from '../web/core.js';
import { configurePeople, applyIdentity, correctPerson, addManualPerson, startFormal, introduction } from '../web/participants.js';
import { VoiceAudio } from '../web/voice-audio.js';
import { ensureInterviewSuggestion, interviewContext, addHostQuestion, applyInterview } from '../web/interview.js';
import { applyRoles, summaryContext, validateSummary } from '../web/intelligence.js';
import { hostPrepare, hostLive } from '../web/interview-ui.js';
import { captureHostVoice } from '../web/voice-settings.js';
import { voicePreparation, voiceSettings } from '../web/voice-settings.js';
import { validateBackground, applyBackground } from '../web/participant-background.js';
import { participantBackground } from '../server/participant-background.mjs';
const vector=i=>Array.from({length:16},(_,j)=>j===i?1:0);
const sample={format:'pcm',rate:16000,channel:1,durationMs:4000,data:Buffer.alloc(128000).toString('base64')};
const quality={singleSpeaker:true,overlap:false,usable:true,speechMs:3000};
async function fixture(t) {
  const parent=resolve('.local-deliverables/v0.6.0/test-data');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'synthetic-'));
  let feature=vector(0), q=quality, calls=0;
  const env={VOICE_EXTRACT_URL:'https://extract.invalid/v1/extract',VOICE_API_KEY:'synthetic-extractor-key',VOICE_MODEL:'synthetic-model',VOICE_STORE_KEY:'ab'.repeat(32),VOICE_STORE_DIR:dir,VOICE_MATCH_THRESHOLD:'.8',VOICE_MATCH_MARGIN:'.15',VOICE_NEW_THRESHOLD:'.2',VOICE_CALIBRATION_ID:'synthetic-test-only',VOICE_VERIFIED:'true'};
  const provider=async (_url,options)=>{calls++;const req=JSON.parse(options.body);assert.equal(req.model,env.VOICE_MODEL);assert.equal(options.redirect,'error');return Response.json({embedding:feature,model:env.VOICE_MODEL,quality:q});};
  const voice=createVoiceService(env,provider);
  t.after(async()=>{voice.close();assert.ok(dir.startsWith(parent+ '\\')||dir.startsWith(parent+'/'));await rm(dir,{recursive:true,force:true});});
  return {voice,env,provider,dir,set(i){feature=vector(i);},quality(v){q=v;},calls:()=>calls};
}
const match=(stream='stream1',phase='opening')=>({sessionId:'session1',segmentId:'segment1',streamId:stream,phase,expectedGuests:2,sample});
test('未配置、未验证、未校准不能伪装为可用；不泄露服务密钥',async()=>{
  const v=createVoiceService({});try{assert.equal(v.status().ready,false);await assert.rejects(v.handle('enroll',{consent:true,sample}),/未配置/);assert.doesNotMatch(JSON.stringify(v.status()),/embedding|STORE_KEY|API_KEY/);}finally{v.close();}
});
test('主持人档案加密持久化、取消不覆盖、按设备隔离、删除可核验',async t=>{
  const f=await fixture(t),v=f.voice;
  await assert.rejects(v.handle('enroll',{sample},'a'),/同意/);
  await v.handle('enroll',{consent:true,sample},'a');
  const bytes=await readFile(join(f.dir,(await readdir(f.dir))[0]));assert.ok(!bytes.includes(Buffer.from('embedding')));
  assert.equal((await v.handle('status',{},'a')).host.registered,true);assert.equal((await v.handle('status',{},'b')).host.registered,false);
  const controller=new AbortController();controller.abort();await assert.rejects(v.handle('enroll',{consent:true,sample},'a',controller.signal));
  assert.equal((await v.handle('status',{},'a')).host.registered,true);
  const second=createVoiceService(f.env,f.provider);try{assert.equal((await second.handle('status',{},'a')).host.registered,true);}finally{second.close();}
  await v.handle('delete-host',{},'a');assert.equal((await v.handle('status',{},'a')).host.registered,false);
});
test('真实音频质量接口拒绝短句、混叠、编码错误及模型版本混用',async t=>{
  const f=await fixture(t),v=f.voice;
  for(const q of [{...quality,overlap:true},{...quality,speechMs:500},{...quality,singleSpeaker:false}]){f.quality(q);await assert.rejects(v.handle('enroll',{consent:true,sample}),/声音不足/);}
  f.quality(quality);await assert.rejects(v.handle('enroll',{consent:true,sample:{...sample,format:'ogg'}}),/编码/);
  await assert.rejects(v.handle('enroll',{consent:true,sample:{...sample,durationMs:500}}),/时长/);
});
test('主持人预录匹配、两位嘉宾自动建档、跨流稳定、未知不强归、结束即清理',async t=>{
  const f=await fixture(t),v=f.voice;await v.handle('enroll',{consent:true,sample});
  const h=await v.handle('match',match());assert.equal(h.participant.role,'host');
  f.set(1);const g1=await v.handle('match',match());assert.equal(g1.participant.role,'guest');
  f.set(2);const g2=await v.handle('match',match());assert.notEqual(g1.participant.id,g2.participant.id);
  f.set(1);const again=await v.handle('match',match('reconnect','formal'));assert.equal(again.participant.id,g1.participant.id);
  assert.doesNotMatch(JSON.stringify(again),/embedding|synthetic-extractor-key/);
  f.set(3);const unknown=await v.handle('match',match('reconnect','formal'));assert.equal(unknown.participant,null);
  await v.handle('end',{sessionId:'session1'});await assert.rejects(v.handle('match',match()),/已清理/);
});
test('重启丢失临时特征时明确要求新建访谈，不能无依据换号',async t=>{
  const f=await fixture(t);await f.voice.handle('enroll',{consent:true,sample});
  const r=await f.voice.handle('match',{...match('s2','formal'),hasKnownGuests:true});assert.equal(r.needsOpening,true);assert.match(r.reason,/新建访谈/);assert.equal(r.participant,undefined);
});
function people() {const topic=newTopic('host'),s=topic.sessions[0];configurePeople(s,2,'voice');s.confirmed=true;return {topic,s};}
function identify(s,seg,p){seg.asr={streamId:'stream1',receivedAt:Date.now()};return applyIdentity(s,seg,{participant:p,segmentId:seg.id,streamId:'stream1'},{sessionId:s.id,revision:seg.revision});}
test('开场不出题、不进入摘要；无姓名按编号，不足人数有恢复入口',()=>{
  const {topic,s}=people();assert.equal(ensureInterviewSuggestion(s),null);
  const seg=addSegment(s,'我负责产品设计。');identify(s,seg,{id:s.id+':g1',role:'guest'});introduction(s,seg);
  assert.equal(s.participants[0].label,'被访谈者1');assert.match(s.participants[0].background,/负责产品/);
  assert.equal(summaryContext(topic,s).segments.length,0);assert.throws(()=>startFormal(s),/人数/);
  startFormal(s,true);assert.ok(ensureInterviewSuggestion(s));
  const html=hostLive(topic,s,{});assert.match(html,/本场人物/);
  assert.match(hostPrepare(topic,s,{}),/expectedGuests/);assert.match(hostPrepare(topic,s,{}),/设置主持人声音/);
});
test('晚到声纹不能覆盖转写修订、人工更正、已结束会话及跨流片段',()=>{
  const {s}=people(),seg=addSegment(s,'连续发言用于匹配。');seg.asr={streamId:'s1'};
  const ticket={sessionId:s.id,revision:0},result={participant:{id:s.id+':h',role:'host'},segmentId:seg.id,streamId:'s1'};
  correctSegment(s,seg.id,'人工更正后的内容。','unknown');assert.equal(applyIdentity(s,seg,result,ticket),false);
  seg.roleSource='voice';assert.equal(applyIdentity(s,seg,{...result,streamId:'other'},{...ticket,revision:seg.revision}),false);
  s.endedAt='now';assert.equal(applyIdentity(s,seg,result,{...ticket,revision:seg.revision}),false);
});
test('语境角色不能覆盖声纹模式；人物更正撤回事实、摘要和所有回应',()=>{
  const {s}=people(),a=addManualPerson(s),b=addManualPerson(s),seg=addSegment(s,'我叫张三，我负责研发。');
  identify(s,seg,{id:a.id,role:'guest'});introduction(s,seg);
  assert.deepEqual(applyRoles(s,{assignments:[]},{segments:[]}),[]);
  s.claims=[{segmentId:seg.id}];s.questions=[{id:'q',status:'answered',responses:[{participantId:a.id}],response:{participantId:a.id}}];s.interviewSummary={};
  correctPerson(s,seg,b.id);assert.equal(seg.participantId,b.id);assert.equal(s.claims.length,0);assert.equal(s.questions[0].responses,undefined);assert.equal(s.interviewSummary,undefined);
});
test('多位嘉宾回应分别记账，嘉宾2不能自动完成嘉宾1回应',()=>{
  const {topic,s}=people(),g1=addManualPerson(s),g2=addManualPerson(s);startFormal(s,true);
  const q=addHostQuestion(s,'你们各自负责什么？');
  const one=addSegment(s,'我负责研发。');identify(s,one,{id:g2.id,role:'guest'});
  let ctx=interviewContext(topic,s,one);
  const raw=seg=>({analysisVersion:2,claims:[],candidates:[],hostQuestions:[],reviews:[],responses:[{questionId:q.id,segmentId:seg.id,quote:seg.text}]});
  applyInterview(s,one,raw(one),ctx,'model');assert.equal(q.status,'asked');assert.equal(q.responses[0].participantId,g2.id);
  const two=addSegment(s,'我负责设计。');identify(s,two,{id:g1.id,role:'guest'});ctx=interviewContext(topic,s,two);applyInterview(s,two,raw(two),ctx,'model');assert.equal(q.status,'answered');assert.equal(q.responses.length,2);
});
test('摘要、普通导出保留具体人物但不包含声纹特征',()=>{
  const {topic,s}=people(),g=addManualPerson(s);startFormal(s,true);const seg=addSegment(s,'我负责设计。');identify(s,seg,{id:g.id,role:'guest'});
  const ctx=summaryContext(topic,s),raw={overview:[{text:'负责设计',sources:[{segmentId:seg.id,quote:seg.text}]}],chapters:s.items.map(i=>({itemId:i.id,points:[]})),followUps:[]};
  assert.equal(validateSummary(raw,ctx).overview[0].sources[0].participantId,g.id);
  raw.overview[0].sources[0].participantId='wrong';assert.throws(()=>validateSummary(raw,ctx),/人物/);
  const md=exportMarkdown(topic);assert.match(md,/被访谈者1/);assert.doesNotMatch(md,/embedding|VOICE_API_KEY/);
});
test('音频环形缓存按真实时间取样，过期、短句、断裂均不可用于匹配',()=>{
  const ring=new VoiceAudio();for(let i=0;i<300;i++)ring.push({format:'pcm',startMs:i*20,endMs:(i+1)*20,bytes:new Uint8Array(640)});
  assert.equal(ring.sample(0,4000).durationMs,4000);assert.equal(ring.sample(0,500),null);
  ring.push({format:'pcm',startMs:6200,endMs:6220,bytes:new Uint8Array(640)});assert.equal(ring.sample(4000,6220),null);ring.clear();assert.equal(ring.sample(0,4000),null);
});
test('主持人采集取消会停止麦克风且不触发注册保存',async()=>{
  let stopped=0;const controller=new AbortController();
  const gm={audio:{async openCapture(){return {stream:new ReadableStream({start(){controller.abort();}}),async stop(){stopped++;}};}}};
  await assert.rejects(captureHostVoice(gm,controller.signal),/取消/);assert.ok(stopped>=1);
});
test('HTTP 声纹接口沿用认证、未配置明确失败且不返回密钥',async t=>{
  const server=createService({GATEWAY_TOKEN:'synthetic-device-token-32-characters'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/voice/status')).status,401);
  const headers={Authorization:'Bearer synthetic-device-token-32-characters','Content-Type':'application/json'};
  const status=await(await fetch(base+'/api/voice/status',{headers})).json();assert.equal(status.ready,false);
  const res=await fetch(base+'/api/voice/enroll',{method:'POST',headers,body:JSON.stringify({consent:true,sample})});assert.equal(res.status,503);assert.doesNotMatch(await res.text(),/synthetic-device-token/);
});


test('准备页切换到原模式后恢复正式阶段，旧记录保持原模式',()=>{
  const {s}=people();configurePeople(s,1,'legacy');assert.equal(s.phase,'formal');assert.ok(ensureInterviewSuggestion(s));
  const old=newTopic('host').sessions[0];addSegment(old,'旧版记录。');assert.match(hostPrepare({title:'旧访谈'},old,{}),/value="legacy" selected/);assert.throws(()=>configurePeople(old,1,'voice'),/不能切换/);
});
test('人物更正重新关联介绍证据，不能残留在旧人物档案',()=>{
  const {s}=people(),a=addManualPerson(s),b=addManualPerson(s),seg=addSegment(s,'我叫张三，我负责研发。');identify(s,seg,{id:a.id,role:'guest'});introduction(s,seg);assert.equal(a.alias,'张三');correctPerson(s,seg,b.id);assert.equal(a.alias,undefined);assert.equal(b.alias,'张三');assert.equal(b.backgroundEvidence.participantId,b.id);
});

test('正式阶段允许前几轮补齐未建档嘉宾，短应答不能创建人物',async t=>{
  const f=await fixture(t),v=f.voice;await v.handle('enroll',{consent:true,sample});await v.handle('match',match());
  f.set(1);let r=await v.handle('match',{...match('s1','formal'),allowNewGuest:true,text:'嗯，好。'});assert.equal(r.participant,null);
  r=await v.handle('match',{...match('s1','formal'),allowNewGuest:true,text:'我负责产品设计。'});assert.equal(r.participant.role,'guest');
  f.set(2);r=await v.handle('match',{...match('s2','formal'),allowNewGuest:true,text:'我负责研发。'});assert.equal(r.participant.role,'guest');
  f.set(3);r=await v.handle('match',{...match('s2','formal'),allowNewGuest:true,text:'我是后来加入的第三个人。'});assert.equal(r.participant,null);
});
test('声音 UI 沿用准备、设置、开场路径；录入需要同意且不显示虚假成功',()=>{
  const {s}=people();const status={ready:true,preview:true,host:{registered:false}};
  assert.match(voicePreparation(s,status),/嘉宾无需准备/);assert.match(voicePreparation(s,status),/name="expectedGuests"/);
  const idle=voiceSettings(status,'idle','');assert.match(idle,/data-action="voice-enroll" disabled/);assert.doesNotMatch(idle,/保存成功/);
  assert.match(voiceSettings(status,'capturing','',3200),/value="3200"/);assert.match(voiceSettings(status,'processing','正在处理'),/正在处理/);
  assert.match(voiceSettings({...status,host:{registered:true}},'idle',''),/重新录入声音/);
});
test('介绍模型只补充本人明确原话，异步结果不能覆盖人物更正或手动别名',async()=>{
  const {s}=people(),g=addManualPerson(s),seg=addSegment(s,'我是张三，我的工作是产品设计。');identify(s,seg,{id:g.id,role:'guest'});
  const input={participantId:g.id,segments:[{id:seg.id,participantId:g.id,text:seg.text}]};
  const raw={participantId:g.id,segmentId:seg.id,alias:'张三',background:'我的工作是产品设计',quote:seg.text};
  const r=await participantBackground(input,{base:'https://synthetic.invalid',key:'test',model:'test'},{fetchImpl:async()=>Response.json({choices:[{message:{content:JSON.stringify(raw)}}]})});
  const ticket={participantId:g.id,revision:seg.revision,alias:''};g.alias='手动别名';assert.equal(applyBackground(s,seg,r,ticket),true);assert.equal(g.alias,'手动别名');assert.match(g.background,/产品设计/);
  assert.throws(()=>validateBackground({...raw,alias:'李四'},input),/原话/);
  const third={...input,segments:[{...input.segments[0],text:'我是主持人，我的同事叫张三。'}]};assert.throws(()=>validateBackground({...raw,background:'',quote:third.segments[0].text},third),/自我介绍/);
  seg.revision++;assert.equal(applyBackground(s,seg,r,ticket),false);
});
