// Real local inference using explicitly synthetic OS speech; no microphone/cloud.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { decodeFile } from '../server/volc-file.mjs';
import { createVoiceService } from '../server/voice.mjs';
const directory=resolve('.local-deliverables/v0.6.0/synthetic-audio');
const voice=createVoiceService(process.env), token='synthetic-test-'+randomUUID();
const sessionId=randomUUID();
async function sample(name) {
  const bytes=await readFile(join(directory,name));
  const pcm=await decodeFile(bytes,AbortSignal.timeout(15000),process.env.FFMPEG_PATH || 'ffmpeg');
  return {format:'pcm',rate:16000,channel:1,durationMs:pcm.length/32,data:pcm.toString('base64')};
}
const report={at:new Date().toISOString(),syntheticOnly:true,cloudCalls:0,physicalMicrophone:false,checks:[]};
try {
  const status=await voice.handle('status',{},token);assert.equal(status.ready,true);assert.equal(status.preview,true);
  const h=await sample('host-enroll.wav'), h2=await sample('host-return.wav'), g=await sample('guest-enroll.wav');
  await voice.handle('enroll',{consent:true,sample:h},token);report.checks.push('host-enroll');
  const match=async(audio,streamId='first')=>voice.handle('match',{sessionId,segmentId:randomUUID(),streamId,expectedGuests:1,phase:'opening',text:'这是用于本地检查的合成测试发言。',sample:audio},token);
  assert.equal((await match(h)).participant?.role,'host');report.checks.push('same-sample-host');
  assert.equal((await match(h2,'reconnect')).participant?.role,'host');report.checks.push('new-text-same-host');
  const guest=await match(g);assert.equal(guest.participant?.role,'guest');report.checks.push('different-voice-guest');
  assert.equal((await match(g,'reconnect')).participant?.id,guest.participant.id);report.checks.push('guest-cross-stream');
  const opus=await readFile(join(directory,'guest-opus.ogg'));
  assert.equal((await match({format:'ogg',rate:16000,channel:1,durationMs:g.durationMs,data:opus.toString('base64')},'ogg-reconnect')).participant?.id,guest.participant.id);report.checks.push('ogg-opus-decode-and-match');
  await voice.handle('end',{sessionId},token);report.checks.push('session-cleanup');
  report.passed=true;
} finally {
  await voice.handle('delete-host',{},token);voice.close();
}
const output=resolve('.local-deliverables/v0.6.0/verification');await mkdir(output,{recursive:true});
await writeFile(join(output,'真实模型_系统合成声音检查.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
