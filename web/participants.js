// Business identity is independent of ASR speaker numbers and display names.
import { uid, now } from './core.js';
import { invalidateInterview } from './interview.js';
export function configurePeople(s, count, mode) {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('嘉宾人数须为 1–5，不包含主持人。');
  if (!['voice', 'legacy'].includes(mode)) throw new Error('请选择声音识别或原模式。');
  if ((s.identityMode || (s.segments.length?'legacy':null)) && (s.identityMode || 'legacy') !== mode && s.segments.length) throw new Error('已有发言后不能切换身份模式，请新建访谈。');
  const changedMode=s.identityMode!==mode;
  s.expectedGuests = count; s.identityMode = mode; s.participants ||= [];
  if (!s.phase || changedMode && !s.segments.length) s.phase = mode === 'voice' ? 'opening' : 'formal';
}
export const personLabel = (s, id) => s.participants?.find(p => p.id === id)?.alias || s.participants?.find(p => p.id === id)?.label || '待识别';
export const segmentLabel = (s, seg) => seg.participantId ? personLabel(s, seg.participantId) : ({host:'主持人',guest:'嘉宾（人物待确认）'})[seg.role] || '待识别';
export function openingProgress(s) {
  const guests = (s.participants || []).filter(p => p.role === 'guest').length;
  return { guests, expected: s.expectedGuests || 1, unknown: s.segments.filter(x => x.phase === 'opening' && !x.participantId).length };
}
export function startFormal(s, acceptIncomplete = false) {
  if (s.endedAt || s.paused || s.phase !== 'opening') throw new Error('当前不能切换阶段。');
  const p = openingProgress(s);
  if (!acceptIncomplete && (p.guests !== p.expected || p.unknown)) throw new Error('人数不符或仍有待识别片段，请补充介绍、调整人数，或选择按当前人数继续。');
  s.phase = 'formal'; s.formalStartedAt = now(); s.revision++;
}
export function applyIdentity(s, seg, result, ticket) {
  if (s.endedAt || s.paused || seg.revision !== ticket.revision || s.id !== ticket.sessionId || seg.roleSource === 'manual' || s.identityMode !== 'voice') return false;
  if (result.segmentId !== seg.id || result.streamId !== seg.asr?.streamId) return false;
  const p = result.participant;
  if (p && (!['host','guest'].includes(p.role) || typeof p.id !== 'string' || !p.id.startsWith(s.id + ':'))) throw new Error('声音人物结果无效。');
  if (p && !s.participants.some(x => x.id === p.id)) s.participants.push({ id:p.id, role:p.role, label:p.role === 'host' ? '主持人' : `被访谈者${s.participants.filter(x=>x.role==='guest').length+1}` });
  seg.participantId = p?.id || null; seg.role = p?.role || 'unknown'; seg.roleSource = 'voice';
  seg.identityStatus = p ? 'matched' : 'unknown'; seg.identityReason = result.reason || '';
  seg.identityReadyAt = Date.now(); seg.identityLatencyMs = seg.identityReadyAt - (seg.asr?.receivedAt || seg.identityReadyAt);
  seg.revision++; seg.analyzedRevision = null; s.revision++; return true;
}
export function correctPerson(s, seg, id) {
  const p = s.participants?.find(p => p.id === id);
  if (!seg || (id && !p) || (s.paused && !s.endedAt)) throw new Error('人物更正无效。');
  seg.edits.push({text:seg.text, role:seg.role, participantId:seg.participantId || null, at:now()});
  for(const person of s.participants || []){if(person.nameEvidence?.segmentId===seg.id){delete person.alias;delete person.nameEvidence;}if(person.backgroundEvidence?.segmentId===seg.id){delete person.background;delete person.backgroundEvidence;}}
  seg.participantId = p?.id || null; seg.role = p?.role || 'unknown'; seg.roleSource = 'manual'; seg.identityStatus = p ? 'corrected' : 'unknown';
  seg.revision++; s.revision++; invalidateInterview(s); s.claims=[]; s.actions=[];
  for (const turn of s.segments) turn.analyzedRevision = null;
  introduction(s,seg);
}
export function addManualPerson(s, role = 'guest') {
  if (!['host','guest'].includes(role) || s.endedAt || s.paused) throw new Error('当前不能添加人物。');
  s.participants ||= [];
  if (role === 'host' && s.participants.some(p=>p.role==='host')) return s.participants.find(p=>p.role==='host');
  if (role === 'guest' && s.participants.filter(p=>p.role==='guest').length>=5) throw new Error('最多五位嘉宾。');
  const p={id:`${s.id}:${uid()}`,role,label:role==='host'?'主持人':`被访谈者${s.participants.filter(p=>p.role==='guest').length+1}`,source:'manual'};
  s.participants.push(p); s.revision++; return p;
}
// Extract only an explicitly spoken self-description, never infer missing identity.
export function introduction(s, seg) {
  if (seg.phase !== 'opening' || !seg.participantId) return;
  const p=s.participants.find(p=>p.id===seg.participantId); if (!p || p.role!=='guest') return;
  const name=seg.text.match(/(?:我叫|我的名字是)([\p{Script=Han}A-Za-z·]{2,16})(?=[，。！？、\s]|$)/u);
  const background=seg.text.match(/(?:我的职业是|我负责|我担任)([^。！？\n]{2,80})/u);
  if (name) {p.alias=name[1]; p.nameEvidence={segmentId:seg.id,quote:name[0],participantId:p.id};}
  if (background) {p.background=background[0];p.backgroundEvidence={segmentId:seg.id,quote:background[0],participantId:p.id};}
}
