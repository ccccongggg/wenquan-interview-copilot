// Creates a private, explicitly uncalibrated development configuration.
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const python=option('--python'), model=option('--model'), runtime=option('--runtime');
if(!python || !model || !runtime)throw new Error('需要 --python、--model 和 --runtime 的已有本地路径。');
for(const path of [python,model,runtime])await access(resolve(path));
const sha=createHash('sha256').update(await readFile(resolve(model))).digest('hex');
const data={VOICE_PROVIDER:'local',VOICE_PYTHON:resolve(python),VOICE_PYTHONPATH:resolve(runtime),VOICE_LOCAL_MODEL:resolve(model),VOICE_LOCAL_MODEL_SHA256:sha,VOICE_MODEL:'wespeaker-zh-resnet34-'+sha.slice(0,12),VOICE_STORE_DIR:resolve('.local-deliverables/v0.6.0/voice-private'),VOICE_STORE_KEY:randomBytes(32).toString('hex'),VOICE_MATCH_THRESHOLD:'.65',VOICE_MATCH_MARGIN:'.12',VOICE_NEW_THRESHOLD:'.35',VOICE_CALIBRATION_ID:'development-only-device-calibration-pending',VOICE_VERIFIED:'false',VOICE_PREVIEW:'true'};
if(option('--ffmpeg'))data.FFMPEG_PATH=resolve(option('--ffmpeg'));
for(const value of Object.values(data))if(/[\r\n"#]/.test(value))throw new Error('配置路径包含不支持的字符。');
await mkdir(resolve('.local-deliverables/v0.6.0/voice-private'),{recursive:true});
await writeFile(resolve('.env.voice.local'),Object.entries(data).map(([k,v])=>`${k}="${v.replace(/\\/g,'/')}"`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('已创建 .env.voice.local（开发预览，未通过真实设备校准）；已有配置不会覆盖。');
