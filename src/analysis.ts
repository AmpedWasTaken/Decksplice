import { exec, type Analysis } from './core.js';
export function analyzePCM(samples:ArrayLike<number>,duration:number,min=120,max=190):Analysis{
 const onset:number[]=[],energy:number[]=[];let prev=0;
 for(let i=0;i+80<=samples.length;i+=80){let s=0;for(let j=i;j<i+80;j++)s+=samples[j]**2;const e=Math.sqrt(s/80);energy.push(e);onset.push(Math.max(0,e-prev));prev=e;}
 const empty:Analysis={bpm:null,confidence:0,firstBeat:null,cues:[],key:null};if(onset.length<1000)return empty;
 const mean=onset.reduce((a,b)=>a+b,0)/onset.length,x=onset.map(v=>v-mean),power=x.reduce((a,b)=>a+b*b,0);if(power<1e-9)return empty;
 let lag=0,score=0;for(let l=Math.floor(6000/max);l<=Math.ceil(6000/min);l++){let d=0;for(let i=l;i<x.length;i++)d+=x[i]*x[i-l];if(d/power>score){score=d/power;lag=l;}}
 if(score<0.15)return empty;const bpm=Math.round(60000/lag)/10,phase=Array.from({length:lag},()=>0);for(let i=0;i<onset.length;i++)phase[i%lag]+=onset[i];const firstBeat=phase.indexOf(Math.max(...phase))/100;
 const cues:Analysis['cues']=[{slot:0,name:'Estimated first beat',seconds:firstBeat}];
 const secs:number[]=[];for(let i=0;i+100<=energy.length;i+=100)secs.push(energy.slice(i,i+100).reduce((a,b)=>a+b,0)/100);
 const changes:{time:number;value:number}[]=[];for(let i=8;i<secs.length-8;i++){const b=secs.slice(i-8,i).reduce((a,b)=>a+b,0)/8,a=secs.slice(i,i+8).reduce((a,b)=>a+b,0)/8;if(Math.max(a,b)>0.005)changes.push({time:i,value:(a-b)/Math.max(a,b)});}
 const distinct=(sign:number)=>{const r:number[]=[];for(const c of changes.filter(c=>sign*c.value>.4).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)))if(r.every(t=>Math.abs(t-c.time)>16))r.push(c.time);return r.sort((a,b)=>a-b);};
 const rises=distinct(1),falls=distinct(-1),period=60/bpm;
 const add=(slot:number,name:string,t:number|undefined)=>{if(t!==undefined&&t>firstBeat&&t<duration-1)cues.push({slot,name,seconds:Number(Math.max(firstBeat,Math.min(duration-.01,firstBeat+Math.round((t-firstBeat)/period)*period)).toFixed(3))});};
 add(1,'Estimated first drop',rises[0]);if(rises.length>1)add(2,'Estimated last drop',rises.at(-1));add(4,'Estimated breakdown',falls[0]);add(5,'Estimated second breakdown',falls[1]);add(3,'Estimated outro',falls.filter(t=>t>duration*.7).at(-1));
 return {bpm,confidence:Number(score.toFixed(3)),firstBeat,cues,key:null};
}
export async function analyzeFile(path:string,duration:number,min=120,max=190){const {stdout}=await exec('ffmpeg',['-nostdin','-v','error','-i',path,'-map','0:a:0','-ac','1','-ar','8000','-t','900','-f','f32le','-'],{encoding:'buffer',maxBuffer:32*1024*1024,timeout:300000});const b=stdout as Buffer,samples=new Float32Array(Math.floor(b.length/4));for(let i=0;i<samples.length;i++)samples[i]=b.readFloatLE(i*4);return analyzePCM(samples,Math.min(duration,900),min,max);}
