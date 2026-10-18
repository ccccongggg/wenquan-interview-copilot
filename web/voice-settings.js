import { VoiceAudio } from './voice-audio.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const microphone=`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"/></svg>`;
export function voicePreparation(s,status) {
 const mode=s.identityMode || (s.segments.length?'legacy':'voice');
 const label=!status?'尚未检查':status.host?.registered?'已录入，可重复使用':status.ready?'还未录入':status.reason || '声音服务暂不可用';
 return `<section class="card voice-preparation" aria-label="人物与声音准备"><div class="section-head"><div><span class="eyebrow">人物准备</span><h2>先认声音，再聊故事。</h2></div><span class="voice-icon">${microphone}</span></div><p class="fine">主持人提前录入；嘉宾无需准备，开场依次讲话即可建立本场声音档案。</p><div class="voice-host-row"><span class="voice-avatar">主</span><div><strong>主持人声音</strong><p id="prepare-voice-status" class="fine" role="status">${esc(label)}</p></div><button type="button" class="small secondary" data-action="voice-settings">${status?.host?.registered?'管理声音':'设置主持人声音'}</button></div><div class="voice-prep-fields"><label>嘉宾人数<input name="expectedGuests" aria-describedby="guest-count-note" type="number" min="1" max="5" step="1" value="${s.expectedGuests||1}"><span id="guest-count-note" class="fine">1–5 位，不包含主持人</span></label><label>人物识别方式<select name="identityMode"><option value="voice" ${mode==='voice'?'selected':''}>声音档案 · 自动区分人物</option><option value="legacy" ${mode==='legacy'?'selected':''}>原模式 · 仅区分访谈角色</option></select></label></div><ol class="voice-route"><li><span>1</span>主持人声音就绪</li><li><span>2</span>嘉宾依次介绍</li><li><span>3</span>开始正式访谈</li></ol>${status?.preview?'<p class="fine voice-preview-note">开发预览 · 声音模型已接通，真实设备效果待校准。</p>':''}</section>`;
}
export function voiceSettings(status, stage, message, elapsed=0) {
 const active=['capturing','processing'].includes(stage),registered=!!status?.host?.registered;
 const title=stage==='capturing'?'正在听你的声音':stage==='processing'?'正在整理声音档案':registered?'熟悉的声音，留给下一次。':'让问全先认识你的声音。';
 const hint=message || (registered?'主持人声音已保存，下一场访谈可以直接使用。':(status?.ready?'请在安静处连续单独讲话约 10 秒。':status?.reason) || '正在检查声音服务…');
 return `<div class="voice-sheet"><header class="voice-sheet-header"><button type="button" class="back-link" data-action="voice-close">← 返回</button><span class="eyebrow">主持人声音</span></header><div class="voice-profile-hero"><span class="voice-icon large ${stage==='capturing'?'is-recording':''}">${microphone}</span><h2>${title}</h2><p class="muted">只需录入一次。嘉宾的声音会在每场访谈中单独建立。</p></div><div class="voice-state ${active?'active':registered?'saved':''}" role="status"><span class="status-dot"></span><p>${esc(hint)}</p></div>${status?.preview?'<p class="fine voice-preview-note">开发预览：模型正在本地运行，真实眼镜效果尚待校准。</p>':''}
 ${stage==='capturing'?`<div class="voice-recording-progress"><div class="voice-meter" aria-hidden="true">${Array.from({length:17},(_,i)=>`<i style="--bar:${i%5};--delay:${i%4}"></i>`).join('')}</div><p><strong id="voice-recording-seconds">${Math.floor(elapsed/1000)}</strong> / 10 秒</p><progress id="voice-recording-progress" max="10000" value="${elapsed}" aria-label="主持人声音采集进度"></progress><p class="fine">请单独连续讲话，录入完成后自动保存。</p></div>`:`<section class="voice-reading"><span class="eyebrow">可以这样读，也可以自然说话</span><p>“我是今天的主持人。我们会从具体的经历开始，聊一聊为什么做出这个选择、遇到过什么问题，以及接下来想尝试什么。”</p></section>`}
 <details class="voice-retention"><summary>声音如何保存与删除</summary><p class="fine">主持人声音特征加密保存，直到你主动删除。嘉宾声音特征仅用于本场，结束即清理；异常中断最后活动后两小时清理。问全不保存本次原始录音。声音匹配用于区分人物，不核验真实身份。</p></details><label class="voice-consent"><input id="voice-consent" type="checkbox" ${active?'disabled':''}><span>我同意采集并保存我的声音特征</span></label><div class="voice-primary-actions"><button type="button" class="primary wide" data-action="voice-enroll" disabled>${stage==='capturing'?'正在采集…':stage==='processing'?'正在处理…':registered?'重新录入声音':'开始录入 · 约 10 秒'}</button>${active?'<button type="button" class="secondary wide" data-action="voice-cancel">取消录入，保留原档案</button>':''}</div><div class="voice-secondary-actions"><button type="button" class="small" data-action="voice-refresh" ${active?'disabled':''}>刷新状态</button>${registered?`<button type="button" class="small danger" data-action="voice-delete" ${active?'disabled':''}>删除声音档案</button>`:''}</div></div>`;
}
// Enrollment does not connect to ASR and is bounded independently of UI timers.
export async function captureHostVoice(gm, signal, onProgress) {
  const capture=await gm.audio.openCapture({profile:'custom',chunkDurationMs:200,maxQueueMs:3000,overflowStrategy:'error',pickupMode:'frontBalanced',noiseReduction:true,maxDurationMs:10000,signal});
  const ring=new VoiceAudio(),reader=capture.stream.getReader(); let ms=0;
  const stop=()=>{void capture.stop().catch(()=>{});void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(stop,11000);
  try {
    if(signal.aborted)throw new Error('录入已取消。');
    while(ms<10000) {
      const {value,done}=await reader.read();if(done)break;
      if(value.discontinuity || value.droppedFrameCount)throw new Error('采集丢帧，请重新录入。');
      if(!(value.data instanceof Uint8Array) || !Array.isArray(value.frameLengths) || value.frameLengths.reduce((n,x)=>n+x,0)!==value.data.length)throw new Error('采集音频帧无效。');
      let offset=0;for(const length of value.frameLengths){const data=value.data.slice(offset,offset+length);offset+=length;ring.push({format:'ogg',startMs:ms,endMs:ms+20,chunk:{data,frameLengths:[length]}});ms+=20;onProgress?.(Math.min(ms,10000));}
    }
    if(signal.aborted)throw new Error('录入已取消，原有声音档案保留。');
    const sample=ring.sample(0,Math.min(ms,10000));if(!sample)throw new Error('采集不足，请连续单独讲话后重试。');return sample;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',stop);await capture.stop().catch(()=>{});reader.releaseLock();ring.clear();}
}
