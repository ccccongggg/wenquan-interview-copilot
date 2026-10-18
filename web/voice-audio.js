import { OpusOggStream } from './ogg-stream.js';
// Bounded, memory-only ring. Never persisted or exported with interview state.
export class VoiceAudio {
  constructor() { this.frames=[]; this.endMs=0; }
  push(frame) {
    this.frames.push(frame); this.endMs=frame.endMs;
    this.frames=this.frames.filter(x=>x.endMs>this.endMs-60000);
  }
  clear() {this.frames=[];this.endMs=0;}
  sample(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs-startMs<2000 || endMs-startMs>30000) return null;
    const frames=this.frames.filter(x=>x.startMs>=startMs && x.endMs<=endMs);
    if (!frames.length || frames[0].startMs-startMs>40 || endMs-frames[frames.length-1].endMs>40) return null;
    for(let i=1;i<frames.length;i++)if(frames[i].startMs-frames[i-1].endMs>1)return null;
    let bytes, format=frames[0].format;
    if (format==='ogg') {
      const ogg=new OpusOggStream(), pages=[ogg.headers(),...frames.map(f=>ogg.push(f.chunk)),ogg.end()];
      bytes=new Uint8Array(pages.reduce((n,x)=>n+x.length,0));let offset=0;for(const page of pages){bytes.set(page,offset);offset+=page.length;}
    } else {
      bytes=new Uint8Array(frames.reduce((n,x)=>n+x.bytes.length,0));let offset=0;for(const f of frames){bytes.set(f.bytes,offset);offset+=f.bytes.length;}
    }
    let binary=''; for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {format,rate:16000,channel:1,durationMs:frames[frames.length-1].endMs-frames[0].startMs,data:btoa(binary)};
  }
}
