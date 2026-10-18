export function validateBackground(value, context) {
  const seg=context.segments?.find(s=>s.id===value?.segmentId && s.participantId===context.participantId);
  if(!seg || value.participantId!==context.participantId || typeof value.quote!=='string' || !seg.text.includes(value.quote) || !value.quote.trim() || value.quote.length>1200)throw new Error('介绍证据无效。');
  const alias=value.alias==null?'':value.alias, background=value.background==null?'':value.background;
  if(typeof alias!=='string' || alias.length>60 || typeof background!=='string' || background.length>160 || (alias && !value.quote.includes(alias)) || (background && !value.quote.includes(background)))throw new Error('介绍内容必须来自本人原话。');
  // A name must follow a direct self-introduction, never a mention of another person.
  const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(alias && !new RegExp(`(?:我叫|我的名字是|我是)\\s*${escaped}`).test(value.quote))throw new Error('姓名不是明确的自我介绍。');
  if(background && !/(?:我是|我负责|我担任|我的职业是|我的工作是)/.test(value.quote))throw new Error('背景不是明确的自我介绍。');
  return {participantId:context.participantId,segmentId:seg.id,alias,background,quote:value.quote};
}
export function applyBackground(s,seg,value,ticket) {
  if(s.endedAt || seg.phase!=='opening' || seg.revision!==ticket.revision || seg.participantId!==ticket.participantId)return false;
  const p=s.participants?.find(p=>p.id===seg.participantId && p.role==='guest');if(!p)return false;
  const result=validateBackground(value,{participantId:p.id,segments:[seg]});
  const evidence={segmentId:seg.id,participantId:p.id,quote:result.quote};
  if(result.alias && (p.alias||'')===ticket.alias){p.alias=result.alias;p.nameEvidence=evidence;}
  if(result.background){p.background=result.background;p.backgroundEvidence=evidence;}
  s.participantMetadataRevision=(s.participantMetadataRevision||0)+1;return true;
}
