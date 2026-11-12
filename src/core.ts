import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, mkdir, writeFile, stat, copyFile, rm, link, realpath, rename, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const exec = promisify(execFile);
export type Track = { title:string; artist:string; duration?:number; isrc?:string; url?:string };
export type Audio = { path:string; title:string; artist:string; duration:number; codec:string; sampleRate:number; channels:number; bits:number; isrc?:string };
export type Analysis = { bpm:number|null; confidence:number; firstBeat:number|null; cues:{slot:number;name:string;seconds:number}[]; key?:string|null };
export type Entry = { track:Track; status:'ready'|'missing'|'ambiguous'|'lossy'|'error'; source?:string; output?:string; detail?:string; audio?:Audio; analysis?:Analysis };
export const formats = ['aiff','wav','flac'] as const;
export type Format = typeof formats[number];
export const lossless = (codec:string) => codec === 'flac' || codec === 'alac' || /^pcm_[su](8|16|24|32)(le|be)?$/.test(codec) || /^pcm_f(32|64)(le|be)$/.test(codec);
export const norm = (s:string) => s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const safeName = (s:string) => {const x=s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,100).replace(/[. ]+$/g,'');return !x || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x) ? 'track-'+x:x;};
export const contains = (root:string,p:string)=>{const r=relative(root,p);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+(process.platform==='win32'?'\\':'/')));};
export function parseCSV(text:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 text=text.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"'&&!cell)quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw new Error('Unclosed CSV quote');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
export async function readPlaylist(file:string):Promise<Track[]>{
 const rows=parseCSV(await readFile(file,'utf8'));const headers=rows.shift()?.map(norm)??[];
 const index=(...names:string[])=>headers.findIndex(x=>names.includes(x));
 const t=index('title','track','track name','name'),a=index('artist','artists','artist name','artist name s','artist names'),d=index('duration ms','duration milliseconds','duration','duration seconds'),s=index('isrc'),u=index('url','spotify url','track url','track uri');
 if(t<0||a<0)throw new Error('CSV needs title and artist columns.');
 return rows.map((r,i)=>{const title=r[t]?.trim(),artist=r[a]?.trim();if(!title||!artist)throw new Error('Missing title/artist on CSV row '+(i+2));let duration=Number(r[d]);if(headers[d]?.includes('ms')||headers[d]?.includes('milliseconds'))duration/=1000;return {title,artist,duration:duration>0?duration:undefined,isrc:r[s]?.trim()||undefined,url:r[u]?.trim()||undefined};});
}
export async function writeCSV(file:string,tracks:Track[]){const quote=(v:unknown)=>'"'+String(v??'').replace(/"/g,'""')+'"';await writeFile(file,'title,artist,duration seconds,isrc,url\n'+tracks.map(t=>[t.title,t.artist,t.duration,t.isrc,t.url].map(quote).join(',')).join('\n')+'\n',{flag:'wx'});}
export async function probe(path:string):Promise<Audio>{
 const {stdout}=await exec('ffprobe',['-v','error','-select_streams','a:0','-show_streams','-show_format','-of','json',resolve(path)],{maxBuffer:4*1024*1024,timeout:30000});
 const d=JSON.parse(stdout),a=d.streams?.[0];if(!a)throw new Error('No audio stream');const tags:Record<string,string>={};for(const [k,v] of Object.entries({...d.format?.tags,...a.tags}))tags[k.toLowerCase()]=String(v);
 const duration=Number(a.duration??d.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('Invalid duration');
 return {path:resolve(path),title:tags.title??'',artist:tags.artist??'',duration,codec:a.codec_name,sampleRate:Number(a.sample_rate),channels:Number(a.channels),bits:Number(a.bits_per_raw_sample)||Number(a.bits_per_sample)||0,isrc:tags.isrc};
}
export async function verify(path:string):Promise<Audio>{const a=await probe(path);await exec('ffmpeg',['-nostdin','-v','error','-xerror','-i',a.path,'-map','0:a:0','-f','null','-'],{timeout:300000,maxBuffer:1024*1024});return a;}
export async function walk(root:string):Promise<string[]>{const out:string[]=[];for(const e of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(root,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.isFile()&&/\.(flac|wav|aiff?|m4a|mp3|ogg|opus|aac)$/i.test(e.name))out.push(p);}return out;}
export async function scan(root:string,onError:(p:string,e:unknown)=>void=()=>{}):Promise<Audio[]>{const result:Audio[]=[];for(const p of await walk(resolve(root)))try{result.push(await probe(p));}catch(e){onError(p,e);}return result;}
export function matchTrack(t:Track,items:Audio[]):Audio[]{return items.filter(a=>{if(t.isrc&&a.isrc&&norm(t.isrc)!==norm(a.isrc))return false;if(t.duration&&Math.abs(t.duration-a.duration)>3)return false;return norm(t.title)===norm(a.title)&&norm(t.artist)===norm(a.artist);});}
export async function convert(source:string,dest:string,format:Format,t:Track):Promise<Audio>{
 const a=await verify(source);if(!lossless(a.codec))throw new Error('Refusing lossy source ('+a.codec+')');
 await mkdir(dirname(dest),{recursive:true});const tmp=join(dirname(dest),'.decksplice-'+randomUUID()+'.'+format);
 const codec=format==='flac'?'flac':format==='aiff'?'pcm_s16be':'pcm_s16le';
 try{await exec('ffmpeg',['-nostdin','-v','error','-n','-i',a.path,'-map','0:a:0','-map_metadata','-1','-c:a',codec,...(format==='flac'?[]:['-ar','44100','-ac','2']),'-metadata','title='+t.title,'-metadata','artist='+t.artist,...(t.isrc?['-metadata','ISRC='+t.isrc]:[]),tmp],{timeout:300000,maxBuffer:1024*1024});const checked=await verify(tmp);if(!lossless(checked.codec)||Math.abs(checked.duration-a.duration)>0.25)throw new Error('Output validation failed');await copyFile(tmp,dest,constants.COPYFILE_EXCL);return {...checked,path:dest};}finally{await rm(tmp,{force:true});}
}
export function outputName(t:Track,i:number,format:Format){return String(i+1).padStart(3,'0')+' - '+safeName(t.artist+' - '+t.title)+'.'+format;}
export function fingerprint(tracks:Track[],format:Format){return createHash('sha256').update(JSON.stringify([tracks,format])).digest('hex');}
export async function atomicWrite(path:string,contents:string){const tmp=path+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,contents,{flag:'wx'});await rename(tmp,path);}finally{await rm(tmp,{force:true});}}
export async function writeReport(out:string,entries:Entry[],id:string){await atomicWrite(join(out,'manifest.json'),JSON.stringify({version:2,id,entries},null,2)+'\n');await atomicWrite(join(out,'playlist.m3u8'),'#EXTM3U\n'+entries.filter(e=>e.status==='ready'&&e.output).map(e=>basename(e.output!)).join('\n')+'\n');}
const xml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
export async function rekordbox(out:string,entries:Entry[]){const ready=entries.filter(e=>e.status==='ready'&&e.output);const tracks=ready.map((e,i)=>{const at=['TrackID="'+(i+1)+'"','Name="'+xml(e.track.title)+'"','Artist="'+xml(e.track.artist)+'"','Location="'+xml(pathToFileURL(e.output!).href)+'"','TotalTime="'+Math.round(e.audio?.duration??0)+'"','SampleRate="'+(e.audio?.sampleRate??0)+'"','BitDepth="'+(e.audio?.bits??0)+'"'];if(e.analysis?.bpm)at.push('AverageBpm="'+e.analysis.bpm+'"');const grid=e.analysis?.bpm&&e.analysis.firstBeat!==null?'<TEMPO Inizio="'+e.analysis.firstBeat+'" Bpm="'+e.analysis.bpm+'" Metro="4/4" Battito="1"/>':'';const cues=(e.analysis?.cues??[]).map(c=>'<POSITION_MARK Name="'+xml(c.name)+'" Type="0" Start="'+c.seconds+'" Num="'+c.slot+'"/>').join('');return '<TRACK '+at.join(' ')+'>'+grid+cues+'</TRACK>';}).join('\n');const refs=ready.map((_,i)=>'<TRACK Key="'+(i+1)+'"/>').join('\n');await atomicWrite(join(out,'rekordbox.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="Decksplice" Version="0.2.0" Company="Decksplice"/><COLLECTION Entries="'+ready.length+'">\n'+tracks+'\n</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Type="1" Name="Decksplice" KeyType="0" Entries="'+ready.length+'">\n'+refs+'\n</NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>\n');}
export async function exportUSB(out:string,dest:string){const manifest=JSON.parse(await readFile(join(out,'manifest.json'),'utf8'));if(manifest.version!==2||!Array.isArray(manifest.entries))throw new Error('Invalid manifest');if(!(await stat(dest)).isDirectory())throw new Error('USB destination must be a directory');const target=join(await realpath(dest),'Decksplice');if(contains(await realpath(out),target)||contains(target,await realpath(out)))throw new Error('Source and destination overlap');const names:string[]=[];const sources:string[]=[];for(const e of manifest.entries as Entry[]){if(e.status!=='ready'||!e.output)continue;const name=basename(e.output);if(!/\.(aiff|wav|flac)$/i.test(name)||names.includes(name))throw new Error('Invalid or duplicate audio filename');const source=join(out,name);if(!(await lstat(source)).isFile())throw new Error('Not a regular audio file: '+name);sources.push(source);names.push(name);}if(!names.length)throw new Error('Nothing to export');await mkdir(target);try{for(const [i,source] of sources.entries())await copyFile(source,join(target,names[i]),constants.COPYFILE_EXCL);await writeFile(join(target,'playlist.m3u8'),'#EXTM3U\n'+names.join('\n')+'\n',{flag:'wx'});}catch(e){await rm(target,{recursive:true,force:true});throw e;}return names.length;}
