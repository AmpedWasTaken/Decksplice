import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { rm } from 'node:fs/promises';
import { norm, type Track } from './core.js';
export type Match={id:string;title:string;artist:string;duration:number;license?:string;page:string};
export interface AudioProvider { id:string; search(t:Track):Promise<Match[]>; download(m:Match,path:string):Promise<void>; }
export async function searchJamendo(t:Track,clientId:string,request:typeof fetch=fetch):Promise<Match[]>{
 const url=new URL('https://api.jamendo.com/v3.0/tracks/');url.search=new URLSearchParams({client_id:clientId,format:'json',search:t.artist+' '+t.title,limit:'30',audiodlformat:'flac',track_type:'single albumtrack'}).toString();
 const res=await request(url,{signal:AbortSignal.timeout(20000)});if(!res.ok)throw new Error('Jamendo HTTP '+res.status);const body=await res.json() as {headers?:{status:string};results?:Record<string,unknown>[]};if(body.headers?.status!=='success'||!Array.isArray(body.results))throw new Error('Jamendo unsuccessful response');
 return body.results.filter(r=>r.audiodownload_allowed===true&&typeof r.audiodownload==='string'&&r.audiodownload&&/^\d+$/.test(String(r.id))&&norm(String(r.name))===norm(t.title)&&norm(String(r.artist_name))===norm(t.artist)&&(!t.duration||Math.abs(Number(r.duration)-t.duration)<=3)).map(r=>({id:String(r.id),title:String(r.name),artist:String(r.artist_name),duration:Number(r.duration),license:typeof r.license_ccurl==='string'?r.license_ccurl:undefined,page:'https://www.jamendo.com/track/'+r.id}));
}
export function jamendo(clientId:string):AudioProvider{return {id:'jamendo',search:t=>searchJamendo(t,clientId),async download(m,path){if(!/^\d+$/.test(m.id))throw new Error('Invalid Jamendo ID');const url=new URL('https://api.jamendo.com/v3.0/tracks/file/');url.search=new URLSearchParams({client_id:clientId,id:m.id,audioformat:'flac',action:'download'}).toString();const res=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!res.ok||!res.body||new URL(res.url).protocol!=='https:')throw new Error('Jamendo download failed: '+res.status);
 let bytes=0;const guard=new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;cb(bytes>300*1024*1024?new Error('Download exceeds 300 MB'):null,chunk);}});
 try{await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),guard,createWriteStream(path,{flags:'wx'}));}catch(e){await rm(path,{force:true});throw e;}
 }};}
export function discoveryLinks(t:Track){const q=encodeURIComponent(t.artist+' '+t.title);return {bandcamp:'https://bandcamp.com/search?q='+q,soundcloud:'https://soundcloud.com/search/sounds?q='+q,beatport:'https://www.beatport.com/search?q='+q};}
