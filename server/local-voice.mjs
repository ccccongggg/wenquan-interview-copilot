import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeFile } from './volc-file.mjs';

export function localVoiceExtractor(env) {
  const configured=!!(env.VOICE_PYTHON && env.VOICE_LOCAL_MODEL && /^[a-f0-9]{64}$/i.test(env.VOICE_LOCAL_MODEL_SHA256 || '') && existsSync(env.VOICE_PYTHON) && existsSync(env.VOICE_LOCAL_MODEL));
  const worker=fileURLToPath(new URL('./local-voice.py',import.meta.url));
  let queue=Promise.resolve(), probePromise;
  async function invoke(input, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const child=spawn(env.VOICE_PYTHON,[worker],{windowsHide:true,env:{...process.env,...env,PYTHONPATH:env.VOICE_PYTHONPATH || ''},stdio:['pipe','pipe','pipe']});
      let output='',settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>{child.kill();finish(new Error('声音处理已取消。'));};
      const timer=setTimeout(()=>{child.kill();finish(new Error('声音模型处理超时。'));},25000);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.length>100000){child.kill();finish(new Error('声音模型结果超限。'));}});
      child.stderr.resume();child.stdin.on('error',()=>{});
      child.on('error',()=>finish(new Error('本地声音模型环境不可用。')));
      child.on('close',code=>{if(settled)return;try{const result=JSON.parse(output);if(code || result.error)throw Error();finish(null,result);}catch{finish(new Error('声音模型未接受该片段，请补充清晰的单人讲话。'));}});
      if(signal?.aborted)abort();else child.stdin.end(JSON.stringify(input));
    });
  }
  return {
    configured,
    async probe() {if(!configured)return false;probePromise ||= invoke({probe:true}).then(r=>r.ok===true).catch(()=>false);return probePromise;},
    async extract(sample,signal) {
      const next=queue.catch(()=>{}).then(async()=>{
        signal?.throwIfAborted();
        const source=Buffer.from(sample.data,'base64');
        const pcm=sample.format==='pcm'?source:await decodeFile(source,signal,env.FFMPEG_PATH || 'ffmpeg');
        if(pcm.length<64000 || pcm.length>960000)throw new Error('音频有效时长须为 2–30 秒。');
        return invoke({pcm:pcm.toString('base64')},signal);
      });queue=next;return next;
    }
  };
}
