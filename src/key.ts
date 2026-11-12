// Estimate tonal center from sampled chroma. Percussion-heavy tracks may have no reliable key.
export type KeyEstimate = { key:string|null; camelot:string|null; keyConfidence:number };
const names=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const major=[8,3,10,5,12,7,2,9,4,11,6,1],minor=[5,12,7,2,9,4,11,6,1,8,3,10];
const profiles=[
 [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
 [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]
];
const unknown:KeyEstimate={key:null,camelot:null,keyConfidence:0};
function correlation(a:number[],b:number[]){const am=a.reduce((s,x)=>s+x,0)/12,bm=b.reduce((s,x)=>s+x,0)/12;let cross=0,aa=0,bb=0;for(let i=0;i<12;i++){const x=a[i]-am,y=b[i]-bm;cross+=x*y;aa+=x*x;bb+=y*y;}return aa*bb>0?cross/Math.sqrt(aa*bb):0;}
export function classifyChroma(chroma:number[]):KeyEstimate{
 if(chroma.length!==12||chroma.some(x=>!Number.isFinite(x)||x<0)||chroma.reduce((a,b)=>a+b,0)<=0)return {...unknown};
 const candidates:{root:number;mode:number;score:number}[]=[];
 for(let root=0;root<12;root++)for(let mode=0;mode<2;mode++)candidates.push({root,mode,score:correlation(Array.from({length:12},(_,i)=>chroma[(root+i)%12]),profiles[mode])});
 candidates.sort((a,b)=>b.score-a.score);
 const best=candidates[0],margin=best.score-candidates[1].score;
 if(best.score<0.55||margin<0.035)return {...unknown,keyConfidence:Number(Math.max(0,margin).toFixed(3))};
 return {key:names[best.root]+(best.mode?' minor':' major'),camelot:(best.mode?minor:major)[best.root]+(best.mode?'A':'B'),keyConfidence:Number(margin.toFixed(3))};
}
// At most 120 windows distributed across the entire analysis interval; Goertzel
// measures note-frequency energy without introducing a native DSP dependency.
export function estimateKey(samples:ArrayLike<number>,rate=8000):KeyEstimate{
 const n=Math.round(rate*0.5);if(samples.length<n*2)return {...unknown};
 const windows=Math.min(120,Math.floor(samples.length/n)),chroma=Array(12).fill(0) as number[];
 const coeff=Array.from({length:48},(_,i)=>2*Math.cos(2*Math.PI*(440*2**((i+36-69)/12))/rate));
 const hann=Float64Array.from({length:n},(_,i)=>0.5-0.5*Math.cos(2*Math.PI*i/(n-1)));
 const frame=new Float64Array(n);
 for(let w=0;w<windows;w++){
  const start=Math.round(w*(samples.length-n)/(windows-1));let energy=0;
  for(let i=0;i<n;i++){frame[i]=samples[start+i]*hann[i];energy+=frame[i]**2;}
  if(energy<1e-5)continue;
  const local=Array(12).fill(0) as number[];
  for(let note=0;note<48;note++){let s1=0,s2=0;const c=coeff[note];for(let i=0;i<n;i++){const s=frame[i]+c*s1-s2;s2=s1;s1=s;}local[note%12]+=Math.sqrt(Math.max(0,s1*s1+s2*s2-c*s1*s2));}
  const total=local.reduce((a,b)=>a+b,0);if(total>0)for(let i=0;i<12;i++)chroma[i]+=local[i]/total;
 }
 return classifyChroma(chroma);
}
