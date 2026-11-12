#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve,join,basename } from 'node:path';
import { mkdir,mkdtemp,rm,readdir,readFile,realpath,lstat,open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { readPlaylist,writeCSV,scan,matchTrack,convert,verify,lossless,outputName,writeReport,rekordbox,exportUSB,formats,contains,fingerprint,exec,type Entry,type Format } from './core.js';
import { jamendo,discoveryLinks } from './providers.js';
import { importSpotify } from './spotify.js';
import { analyzeFile } from './analysis.js';
const clean=(s:string)=>s.replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
const help='DECKSPLICE / From playlist to decks.\n\n  decksplice doctor\n  decksplice import <spotify-url> --out <playlist.csv>\n  decksplice prepare <playlist.csv> --library <folder> --out <folder> [--format aiff|wav|flac] [--jamendo] [--analyze] [--resume] [--jobs 2]\n  decksplice search <playlist.csv>\n  decksplice verify <audio-file>\n  decksplice analyze <audio-file> [--min-bpm 120] [--max-bpm 190]\n  decksplice status --out <prepared-folder>\n  decksplice usb --out <prepared-folder> --drive <existing-directory>\n\n  Spotify metadata: SPOTIFY_ACCESS_TOKEN. Authorized Jamendo audio: JAMENDO_CLIENT_ID.\n  Analysis is experimental. Check beatgrids and cues before playing.\n';
type Options={format:Format;remote:boolean;analysis:boolean;resume:boolean;jobs:number;min:number;max:number};
const exists=async(p:string)=>{try{await lstat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
async function prepare(file:string,library:string|undefined,out:string,opt:Options){
 const key=process.env.JAMENDO_CLIENT_ID;if(opt.remote&&!key)throw new Error('Set JAMENDO_CLIENT_ID');if(!library&&!opt.remote)throw new Error('Provide --library or --jamendo');
 const tracks=await readPlaylist(file);if(!tracks.length)throw new Error('Playlist is empty');await mkdir(out,{recursive:true});out=await realpath(out);
 if(library){library=await realpath(library);if(contains(library,out)||contains(out,library))throw new Error('Library and output must be separate directories');}
 const lockPath=join(out,'.decksplice.lock');const lock=await open(lockPath,'wx');
 try{const id=fingerprint(tracks,opt.format),manifest=join(out,'manifest.json'),entries:Entry[]=tracks.map(track=>({track,status:'missing'}));
 if(opt.resume){const m=JSON.parse(await readFile(manifest,'utf8'));if(m.version!==2||m.id!==id||!Array.isArray(m.entries)||m.entries.length!==tracks.length)throw new Error('Resume requires original playlist and format');for(const [i,e] of (m.entries as Entry[]).entries()){const p=join(out,outputName(tracks[i],i,opt.format));if(e.status==='ready'&&e.output&&basename(e.output)===basename(p)&&(await lstat(p)).isFile()){const a=await verify(p);if(!lossless(a.codec)||!matchTrack(tracks[i],[a]).length)throw new Error('Prepared file changed: '+p);entries[i]={...e,track:tracks[i],output:p,audio:a};}}}
 else if((await readdir(out)).some(n=>n!=='.decksplice.lock'))throw new Error('Output folder must be empty; use --resume');
 const items=library?await scan(library,p=>console.error('Skipping unreadable file: '+clean(p))):[];console.log('Indexed '+items.length+' local files; '+tracks.length+' tracks');
 const provider=opt.remote&&key?jamendo(key):undefined;let next=0;let writes=Promise.resolve();
 const save=()=>{const snapshot=structuredClone(entries);writes=writes.then(()=>writeReport(out,snapshot,id));return writes;};await save();
 async function worker(){while(next<tracks.length){const i=next++,t=tracks[i],output=join(out,outputName(t,i,opt.format));let e=entries[i],temp:string|undefined;
 try{if(e.status!=='ready'){e={track:t,status:'missing'};if(await exists(output))throw new Error('Output exists; refusing overwrite');const matches=matchTrack(t,items),good=matches.filter(a=>lossless(a.codec));
 if(good.length>1)e={...e,status:'ambiguous',detail:'Multiple lossless matches'};
 else if(good.length===1)e={...e,status:'ready',source:good[0].path,output,audio:await convert(good[0].path,output,opt.format,t)};
 else if(provider){const remote=await provider.search(t);if(remote.length>1)e={...e,status:'ambiguous',detail:'Multiple authorized matches'};else if(remote.length===1){temp=await mkdtemp(join(tmpdir(),'decksplice-'));const source=join(temp,'source.flac');await provider.download(remote[0],source);e={...e,status:'ready',source:remote[0].page,detail:remote[0].license,output,audio:await convert(source,output,opt.format,t)};}else e={...e,status:matches.length?'lossy':'missing',detail:'No authorized lossless match'};}
 else if(matches.length)e={...e,status:'lossy',detail:'Only lossy sources matched'};}
 if(opt.analysis&&e.status==='ready'&&e.audio&&e.output){try{e.analysis=await analyzeFile(e.output,e.audio.duration,opt.min,opt.max);}catch(err){e.detail='Analysis failed: '+String(err);}}
 }catch(err){e={track:t,status:'error',detail:String(err)};}finally{if(temp)await rm(temp,{recursive:true,force:true});}
 entries[i]=e;console.log((i+1)+'/'+tracks.length+' '+e.status.toUpperCase()+' '+clean(t.artist+' - '+t.title));await save();}}
 await Promise.all(Array.from({length:Math.min(opt.jobs,tracks.length)},()=>worker()));await writes;await rekordbox(out,entries);const ready=entries.filter(e=>e.status==='ready').length;console.log(ready+'/'+tracks.length+' ready · '+out);if(ready<tracks.length)process.exitCode=2;
 }finally{await lock.close();await rm(lockPath,{force:true});}
}
async function main(){const args=process.argv.slice(2);if(!args.length){console.log(help);if(!process.stdin.isTTY)return;const rl=createInterface({input:process.stdin,output:process.stdout});try{const file=(await rl.question('Playlist CSV: ')).trim(),lib=(await rl.question('Library folder (blank for Jamendo): ')).trim(),out=(await rl.question('Output folder [./decksplice-output]: ')).trim()||'./decksplice-output';await prepare(file,lib||undefined,out,{format:'aiff',remote:!lib,analysis:false,resume:false,jobs:2,min:120,max:190});}finally{rl.close();}return;}
 const cmd=args.shift();if(['--help','-h','help'].includes(cmd!)){console.log(help);return;}if(cmd==='--version'){console.log('0.2.0');return;}
 const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{library:{type:'string'},out:{type:'string'},format:{type:'string',default:'aiff'},jamendo:{type:'boolean'},drive:{type:'string'},analyze:{type:'boolean'},resume:{type:'boolean'},jobs:{type:'string',default:'2'},'min-bpm':{type:'string',default:'120'},'max-bpm':{type:'string',default:'190'},help:{type:'boolean',short:'h'}}});if(v.help){console.log(help);return;}
 const min=Number(v['min-bpm']),max=Number(v['max-bpm']),jobs=Number(v.jobs);if(!Number.isInteger(jobs)||jobs<1||jobs>8)throw new Error('Jobs must be 1..8');if(!Number.isFinite(min)||!Number.isFinite(max)||min<60||max>240||min>=max)throw new Error('BPM range must be 60..240, min < max');
 const one=()=>{if(p.length!==1)throw new Error(cmd+' requires one argument');return p[0];};
 if(cmd==='prepare'){if(!v.out||!formats.includes(v.format as Format))throw new Error('prepare requires --out and valid format');await prepare(one(),v.library,v.out,{format:v.format as Format,remote:!!v.jamendo,analysis:!!v.analyze,resume:!!v.resume,jobs,min,max});}
 else if(cmd==='import'){if(!v.out||!process.env.SPOTIFY_ACCESS_TOKEN)throw new Error('import requires --out and SPOTIFY_ACCESS_TOKEN');const tracks=await importSpotify(one(),process.env.SPOTIFY_ACCESS_TOKEN);if(!tracks.length)throw new Error('No accessible music tracks');await writeCSV(v.out,tracks);console.log(tracks.length+' tracks imported (metadata only)');}
 else if(cmd==='search'){console.log(JSON.stringify((await readPlaylist(one())).map(track=>({track,links:discoveryLinks(track)})),null,2));}
 else if(cmd==='verify'){const a=await verify(one());console.log(JSON.stringify({...a,losslessCodec:lossless(a.codec),note:'Codec does not prove original lossless provenance.'},null,2));if(!lossless(a.codec))process.exitCode=2;}
 else if(cmd==='analyze'){const a=await verify(one());console.log(JSON.stringify(await analyzeFile(a.path,a.duration,min,max),null,2));}
 else if(cmd==='status'){if(!v.out||p.length)throw new Error('status requires --out');const m=JSON.parse(await readFile(join(v.out,'manifest.json'),'utf8'));if(m.version!==2||!Array.isArray(m.entries))throw new Error('Invalid manifest');console.table(m.entries.map((e:Entry)=>({artist:clean(e.track.artist),title:clean(e.track.title),status:e.status,bpm:e.analysis?.bpm??''})));}
 else if(cmd==='usb'){if(!v.out||!v.drive||p.length)throw new Error('usb requires --out and --drive');console.log(await exportUSB(resolve(v.out),resolve(v.drive))+' files copied; not a rekordbox device database.');}
 else if(cmd==='doctor'){for(const t of ['ffmpeg','ffprobe']){await exec(t,['-version'],{timeout:10000});console.log('OK '+t);}console.log('OK Node '+process.version);}
 else throw new Error('Unknown command: '+cmd);
}
main().catch(e=>{console.error('decksplice: '+clean(e instanceof Error?e.message:String(e)));process.exitCode=1;});
