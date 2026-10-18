import { cp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_GATEWAY } from '../web/config.js';
import { normalizeBackend } from '../web/network.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.WENQUAN_SDK_ROOT || [resolve(root,'../plugin-open-platform'), 'E:/jimi_AIglass/plugin-open-platform-main'].find(path=>existsSync(join(path,'PhoneSDK/tools/build-mmpkg.mjs')));
if(!sdk)throw new Error('请设置 WENQUAN_SDK_ROOT 指向已安装的 SDK。');
const {buildMmpkg}=await import(pathToFileURL(join(sdk,'PhoneSDK/tools/build-mmpkg.mjs')).href);
const dist = join(root, 'dist');
let profile;
try { profile = JSON.parse(await readFile(join(root, '.env.connection.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('本机连接配置无法读取；已取消构建，不输出私密内容。'); }
const studioPreview=process.env.WENQUAN_STUDIO_PREVIEW==='true';
const gateway = normalizeBackend(process.env.WENQUAN_GATEWAY_URL || profile?.gateway || DEFAULT_GATEWAY, !studioPreview);
let token = '';
if (profile && normalizeBackend(profile.gateway, true) === gateway) {
  if (typeof profile.accessCode !== 'string' || profile.accessCode.length < 32 || profile.accessCode.length > 256) throw new Error('本机设备访问码无效，已取消构建。');
  token = profile.accessCode;
}
await mkdir(dist, { recursive: true });
// dist 是本工程生成目录；保留源文件和用户配置。
for (const file of await readdir(dist)) await rm(join(dist, file), { recursive: true, force: true });
await cp(join(root, 'web'), dist, { recursive: true });
await writeFile(join(dist, 'config.js'), `export const DEFAULT_GATEWAY = ${JSON.stringify(gateway)};\nexport const DEFAULT_GATEWAY_TOKEN = ${JSON.stringify(token)};\n`, { mode: 0o600 });
await mkdir(join(dist, 'vendor'), { recursive: true });
await cp(join(sdk, 'PhoneSDK/examples/life-desk/vendor/gm-plugin-web-sdk.esm.js'), join(dist, 'vendor/gm-plugin-web-sdk.esm.js'));
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const filename = `wenquan-${manifest.version}${studioPreview?'-StudioPreview':''}.mmpkg`;
const deliveries=join(root,'.local-deliverables/v0.6.0');
await mkdir(deliveries,{recursive:true});
const numbers=(await readdir(deliveries)).filter(x=>/^build-\d+$/.test(x)).map(x=>Number(x.slice(6)));
const buildId=process.env.WENQUAN_BUILD_ID || `build-${String(Math.max(0,...numbers)+1).padStart(3,'0')}`;
if(!/^build-\d{3,}$/.test(buildId))throw new Error('构建编号无效。');
const release=join(deliveries,buildId);
await mkdir(release); // Existing build directories are immutable; EEXIST stops overwrite.
await buildMmpkg(dist, join(release,filename));
if(studioPreview)console.log('Studio 本机预览包：使用回环后端，不作为手机线上安装包。');
console.log(`已构建隔离本机开发包：${join(release,filename)}；未发布，未同步共享 SDK。`);
