// Bitvavo Signal-Bot: prüft alle EUR-Märkte mit > 250k € Volumen, lernt aus dem Kursverlauf,
// schickt Kauf- und Verkaufssignale per ntfy und führt ein Logbuch. Gleiche Logik wie die Radar-App.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
const API='https://api.bitvavo.com/v2';
const CG='https://api.coingecko.com/api/v3';
const MIN_VOL=50000, MIN_VOL3D=250000;   // > 50k € in 24h UND > 250k € in den letzten 3 Tagen
const vol3d=d=>{const n=Math.round(72/TFH[TF]);let s=0;for(let i=Math.max(0,d.c.length-n);i<d.c.length;i++)s+=d.v[i]*d.c[i];return s};
const eligible=m=>m.vol>=MIN_VOL&&(m.vol3d??0)>=MIN_VOL3D;
const SRBARS={'15m':96,'1h':48,'4h':30};   // Bars für Unterstützung/Widerstand
const DAY={'15m':96,'1h':24,'4h':6};       // Bars pro 24h
const TFH={'15m':.25,'1h':1,'4h':4};       // Stunden pro Kerze
const TFMS={'15m':9e5,'1h':36e5,'4h':144e5};
const FEE=0.0025;  // Gebühr pro Seite (Bitvavo Taker 0,25 %)
// Trade-Aufbau: Risiko R = max(sl × ATR, minRisk × Kurs), Ziel = tp × R, Haltedauer h Stunden.
// Der GitHub-Bot testet regelmässig, welcher Aufbau nach Gebühren am besten funktioniert, und veröffentlicht ihn.
let GEO={sl:2,minRisk:0.02,tp:2,h:24};
const STABLE=new Set(['USDC','USDT','EURC','DAI','EURT','PYUSD','FDUSD','TUSD','USDE','EURI','USDS','RLUSD','EURQ','EURR']);
const riskOf=(e,a)=>Math.max(GEO.sl*a,GEO.minRisk*e);
const horBars=()=>Math.max(2,Math.round(GEO.h/TFH[TF]));
const HIST=1000, RETRAIN_MS=30*60e3;

const clip=(v,a,b)=>Math.max(a,Math.min(b,v));
const fmtP=v=>{if(v==null||isNaN(v))return'–';const a=Math.abs(v);const d=a>=1000?2:a>=1?3:a>=0.01?5:8;return v.toLocaleString('de-CH',{minimumFractionDigits:Math.min(d,2),maximumFractionDigits:d})};
const pct=v=>(v>0?'+':'')+v.toFixed(2)+'%';
const fmtR=v=>(v>0?'+':'')+v.toFixed(2)+' R';
/* ---------- Indikatoren ---------- */
function ema(a,n){const k=2/(n+1),o=[];let p;a.forEach((v,i)=>{p=i?v*k+p*(1-k):v;o.push(p)});return o}
function rsi(c,n=14){const o=Array(c.length).fill(50);let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],up=Math.max(d,0),dn=Math.max(-d,0);if(i<=n){g+=up;l+=dn;if(i===n){g/=n;l/=n;o[i]=100-100/(1+g/(l||1e-9))}}else{g=(g*(n-1)+up)/n;l=(l*(n-1)+dn)/n;o[i]=100-100/(1+g/(l||1e-9))}}return o}
function boll(c,n=20,k=2){const o=Array(c.length).fill(null);let s=0,s2=0;for(let i=0;i<c.length;i++){s+=c[i];s2+=c[i]*c[i];if(i>=n){s-=c[i-n];s2-=c[i-n]*c[i-n]}if(i>=n-1){const m=s/n,sd=Math.sqrt(Math.max(0,s2/n-m*m));o[i]={m,u:m+k*sd,l:m-k*sd}}}return o}
function atr(h,l,c,n=14){const o=Array(c.length).fill(null);let p=0;for(let i=0;i<c.length;i++){const tr=i?Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])):h[i]-l[i];if(i<n){p+=tr;if(i===n-1){p/=n;o[i]=p}}else{p=(p*(n-1)+tr)/n;o[i]=p}}return o}
// ADX nach Wilder (Trendstärke und Richtung)
function adx(h,l,c,n=14){const N=c.length,P=Array(N).fill(0),M=Array(N).fill(0),X=Array(N).fill(0);let sT=0,sP=0,sM=0,a=0;
  for(let i=1;i<N;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i],pd=up>dn&&up>0?up:0,md=dn>up&&dn>0?dn:0,tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    if(i<=n){sT+=tr;sP+=pd;sM+=md}else{sT=sT-sT/n+tr;sP=sP-sP/n+pd;sM=sM-sM/n+md}
    if(i>=n){const p=100*sP/(sT||1e-9),m=100*sM/(sT||1e-9),dx=100*Math.abs(p-m)/((p+m)||1e-9);P[i]=p;M[i]=m;a=i<2*n?(a*(i-n)+dx)/(i-n+1):(a*(n-1)+dx)/n;X[i]=a}}
  return{P,M,X}}
// Höchstwert der vorherigen w Kerzen (ohne die aktuelle)
function priorMax(h,w){const o=Array(h.length).fill(null),q=[];for(let i=0;i<h.length;i++){while(q.length&&q[0]<i-w)q.shift();o[i]=q.length?h[q[0]]:null;while(q.length&&h[q[q.length-1]]<=h[i])q.pop();q.push(i)}return o}
// Marktlage Bitcoin je Zeitpunkt: [24h-Veränderung, Trend über/unter EMA 50]
let BTCX=new Map();
function setBtc(src=data){BTCX=new Map();const d=src['BTC-EUR'];if(!d)return;const D=DAY[TF];for(let i=0;i<d.c.length;i++)BTCX.set(d.ts[i],[i>=D?d.c[i]/d.c[i-D]-1:0,d.c[i]>d.e50[i]?1:-1])}
function prep(cand){
  const ts=cand.map(x=>+x[0]),o=cand.map(x=>+x[1]),h=cand.map(x=>+x[2]),l=cand.map(x=>+x[3]),c=cand.map(x=>+x[4]),v=cand.map(x=>+x[5]);
  const e12=ema(c,12),e26=ema(c,26),mm=c.map((_,i)=>e12[i]-e26[i]),ms=ema(mm,9),mh=mm.map((x,i)=>x-ms[i]);
  const B=boll(c),bw=B.map((b,i)=>b?(b.u-b.l)/b.m:null),vr=v.map((x,i)=>{if(i<20)return 1;let s=0;for(let k=i-20;k<i;k++)s+=v[k];return x/((s/20)||1e-9)});
  const D=DAY[TF],pv=[0],pp=[0];for(let i=0;i<c.length;i++){pv.push(pv[i]+v[i]);pp.push(pp[i]+v[i]*(h[i]+l[i]+c[i])/3)}
  const vw=c.map((_,i)=>{const a=Math.max(0,i-D+1),sv=pv[i+1]-pv[a];return sv>0?(pp[i+1]-pp[a])/sv:c[i]});          // VWAP der letzten 24h
  const rv=c.map((_,i)=>{if(i<8*D)return 1;const v24=pv[i+1]-pv[i+1-D],v7=(pv[i+1-D]-pv[i+1-8*D])/7;return v24/(v7||1e-9)}); // 24h-Volumen ggü. Schnitt der 7 Tage davor
  const AX=adx(h,l,c);
  return{ts,o,h,l,c,v,e20:ema(c,20),e50:ema(c,50),e200:ema(c,200),R:rsi(c),mh,B,bw,A:atr(h,l,c),vr,vw,rv,adx:AX.X,pdi:AX.P,mdi:AX.M,hi24:priorMax(h,D),hi7:priorMax(h,7*D)};
}

/* ---------- Merkmale, aus denen das Modell lernt ---------- */
const FEATS=[
 {n:'Trend EMA 20/50',f:(d,i)=>d.c[i]>d.e50[i]&&d.e20[i]>d.e50[i]?1:d.c[i]<d.e50[i]&&d.e20[i]<d.e50[i]?-1:0,t:v=>v>0?'Aufwärtstrend: Kurs und EMA 20 über EMA 50':'Abwärtstrend: Kurs und EMA 20 unter EMA 50'},
 {n:'Lage zu EMA 200',f:(d,i)=>i<200?0:d.c[i]>d.e200[i]?1:-1,t:v=>v>0?'Kurs über EMA 200 (übergeordnet positiv)':'Kurs unter EMA 200 (übergeordnet negativ)'},
 {n:'EMA-Kreuzung frisch',f:(d,i)=>{for(let k=i-2;k<=i;k++){if(d.e20[k-1]<=d.e50[k-1]&&d.e20[k]>d.e50[k])return 1;if(d.e20[k-1]>=d.e50[k-1]&&d.e20[k]<d.e50[k])return -1}return 0},t:v=>v>0?'Frisches Golden Cross EMA 20/50':'Frisches Death Cross EMA 20/50'},
 {n:'RSI überverkauft <30',f:(d,i)=>d.R[i]<30?1:0,t:(v,d,i)=>'RSI '+d.R[i].toFixed(0)+': überverkauft'},
 {n:'RSI überkauft >70',f:(d,i)=>d.R[i]>70?1:0,t:(v,d,i)=>'RSI '+d.R[i].toFixed(0)+': überkauft'},
 {n:'RSI 50–65',f:(d,i)=>d.R[i]>=50&&d.R[i]<=65?1:0,t:(v,d,i)=>'RSI '+d.R[i].toFixed(0)+': gesundes Momentum'},
 {n:'RSI dreht nach oben',f:(d,i)=>d.R[i]<45&&d.R[i]>d.R[i-3]?1:0,t:(v,d,i)=>'RSI '+d.R[i].toFixed(0)+' dreht von unten nach oben'},
 {n:'MACD-Kreuzung',f:(d,i)=>d.mh[i]>0&&d.mh[i-1]<=0?1:d.mh[i]<0&&d.mh[i-1]>=0?-1:0,t:v=>v>0?'MACD kreuzt Signallinie nach oben':'MACD kreuzt Signallinie nach unten'},
 {n:'MACD-Dynamik',f:(d,i)=>d.mh[i]>0&&d.mh[i]>d.mh[i-1]?1:d.mh[i]<0&&d.mh[i]<d.mh[i-1]?-1:0,t:v=>v>0?'MACD-Histogramm positiv und steigend':'MACD-Histogramm negativ und fallend'},
 {n:'Unter unterem Bollinger-Band',f:(d,i)=>d.B[i]&&d.c[i]<d.B[i].l?1:0,t:()=>'Kurs unter unterem Bollinger-Band'},
 {n:'Über oberem Bollinger-Band',f:(d,i)=>d.B[i]&&d.c[i]>d.B[i].u?1:0,t:()=>'Kurs über oberem Bollinger-Band'},
 {n:'Bollinger-Squeeze',f:(d,i)=>{if(i<80)return 0;let m=1e9;for(let k=i-60;k<=i;k++)if(d.bw[k]!=null&&d.bw[k]<m)m=d.bw[k];return d.bw[i]<=m*1.15?1:0},t:()=>'Bollinger-Squeeze: Bänder eng, Ausbruch möglich'},
 {n:'Volumenspitze',f:(d,i)=>d.vr[i]>1.8?(d.c[i]>d.o[i]?1:-1):0,t:(v,d,i)=>'Volumen '+d.vr[i].toFixed(1)+'× Schnitt mit '+(v>0?'grüner Kerze (Kaufdruck)':'roter Kerze (Verkaufsdruck)')},
 {n:'24h-Momentum',num:1,f:(d,i)=>{const D=DAY[TF];return i<D?0:clip((d.c[i]/d.c[i-D]-1)*10,-1.5,1.5)},t:v=>'24h-Momentum '+pct(v*10)},
 {n:'Volatilität (ATR %)',num:1,f:(d,i)=>clip(d.A[i]/d.c[i]*100/3,0,2),t:v=>'Volatilität '+(v*3).toFixed(2)+'% pro Kerze'},
 {n:'Abstand zu EMA 50',num:1,f:(d,i)=>clip((d.c[i]-d.e50[i])/(d.A[i]||1e-9)/3,-1,1),t:v=>'Kurs '+Math.abs(v*3).toFixed(1)+' ATR '+(v>0?'über':'unter')+' EMA 50'},

 // Erweiterung v2: VWAP, ADX, relatives Volumen, Ausbrüche, Bitcoin-Marktlage, Tageszeit, Kombinationen
 {v2:1,n:'Abstand zum 24h-VWAP',num:1,f:(d,i)=>clip((d.c[i]-d.vw[i])/(d.A[i]||1e-9)/3,-1,1),t:v=>'Kurs '+Math.abs(v*3).toFixed(1)+' ATR '+(v>0?'über':'unter')+' dem 24h-VWAP'},
 {v2:1,n:'Trendstärke (ADX)',num:1,f:(d,i)=>clip(d.adx[i]/50,0,1.5),t:v=>'ADX '+(v*50).toFixed(0)+': '+(v*50>=25?'kräftiger Trend':'kaum Trend')},
 {v2:1,n:'ADX-Richtung',f:(d,i)=>d.adx[i]>=25?(d.pdi[i]>d.mdi[i]?1:-1):0,t:v=>v>0?'Starker Trend nach oben (ADX ≥ 25, +DI vorne)':'Starker Trend nach unten (ADX ≥ 25, −DI vorne)'},
 {v2:1,n:'Relatives Volumen 24h/7T',num:1,f:(d,i)=>clip(Math.log2(d.rv[i]||1),-2,3),t:v=>'Volumen 24h '+(2**v).toFixed(1)+'× der Vorwoche'},
 {v2:1,n:'Abstand zum 24h-Hoch',num:1,f:(d,i)=>d.hi24[i]==null?0:clip((d.c[i]-d.hi24[i])/(d.A[i]||1e-9)/3,-1,1),t:v=>v>=0?'Über dem 24h-Hoch':'Kurs '+Math.abs(v*3).toFixed(1)+' ATR unter dem 24h-Hoch'},
 {v2:1,n:'Ausbruch über 7-Tage-Hoch',f:(d,i)=>d.hi7[i]!=null&&d.c[i]>d.hi7[i]?1:0,t:()=>'Ausbruch über das 7-Tage-Hoch'},
 {v2:1,n:'Bitcoin 24h',num:1,f:(d,i)=>clip(((BTCX.get(d.ts[i])||[0])[0])*10,-1.5,1.5),t:v=>'Bitcoin 24h '+pct(v*10)},
 {v2:1,n:'Bitcoin-Trend',f:(d,i)=>(BTCX.get(d.ts[i])||[0,0])[1],t:v=>v>0?'Bitcoin über EMA 50 (Rückenwind)':'Bitcoin unter EMA 50 (Gegenwind)'},
 {v2:1,n:'Session Europa (7–13 UTC)',f:(d,i)=>{const h=new Date(d.ts[i]).getUTCHours();return h>=7&&h<13?1:0},t:()=>'Europa-Session'},
 {v2:1,n:'Session USA (13–21 UTC)',f:(d,i)=>{const h=new Date(d.ts[i]).getUTCHours();return h>=13&&h<21?1:0},t:()=>'US-Session'},
 {v2:1,n:'Session spät (21–24 UTC)',f:(d,i)=>new Date(d.ts[i]).getUTCHours()>=21?1:0,t:()=>'Späte Session'},
 {v2:1,n:'RSI tief im Aufwärtstrend',f:(d,i)=>d.R[i]<40&&d.c[i]>d.e50[i]&&d.e20[i]>d.e50[i]?1:0,t:(v,d,i)=>'Rücksetzer im Aufwärtstrend (RSI '+d.R[i].toFixed(0)+')'},
 {v2:1,n:'Ausbruch mit Volumen',f:(d,i)=>d.hi24[i]!=null&&d.c[i]>d.hi24[i]&&d.vr[i]>1.5?1:0,t:(v,d,i)=>'Ausbruch über das 24h-Hoch mit '+d.vr[i].toFixed(1)+'× Volumen'},
 {v2:1,n:'Coin und Bitcoin im Aufwärtstrend',f:(d,i)=>d.c[i]>d.e50[i]&&d.e20[i]>d.e50[i]&&(BTCX.get(d.ts[i])||[0,0])[1]>0?1:0,t:()=>'Coin und Bitcoin beide im Aufwärtstrend'},
];
// Welche Merkmale aktiv sind, entscheidet der wöchentliche Vergleich des Bots (v1 = bisher, v2 = erweitert)
let FEATSET='v1',ACTIVE=FEATS.filter(F=>!F.v2),K=ACTIVE.length;
function setFeatSet(s){FEATSET=s==='v2'?'v2':'v1';ACTIVE=FEATSET==='v2'?FEATS:FEATS.filter(F=>!F.v2);K=ACTIVE.length}
const feat=(d,i)=>ACTIVE.map(F=>F.f(d,i));

/* Ergebnis eines Kaufs bei Kerze i: Ziel vor Stop? */
function outcome(d,i){
  return outcomeG(d,i,GEO);
}
function outcomeG(d,i,g){
  const e=d.c[i],a=d.A[i],R=Math.max(g.sl*a,g.minRisk*e),tp=e+g.tp*R,sl=e-R,H=Math.max(2,Math.round(g.h/TFH[TF]));
  const fee=2*FEE*e/R; // Bitvavo-Gebühr für Kauf und Verkauf, in R
  for(let k=i+1;k<=i+H&&k<d.c.length;k++){if(d.l[k]<=sl)return{y:0,r:-1-fee};if(d.h[k]>=tp)return{y:1,r:g.tp-fee}}
  const k=Math.min(i+H,d.c.length-1);return{y:0,r:(d.c[k]-e)/R-fee};
}

/* ---------- Lernen: logistische Regression ---------- */
function fit(X,y,n,iters=160,K=ACTIVE.length){
  const mu=new Float64Array(K),sd=new Float64Array(K);
  for(let i=0;i<n;i++)for(let k=0;k<K;k++)mu[k]+=X[i*K+k];for(let k=0;k<K;k++)mu[k]/=n;
  for(let i=0;i<n;i++)for(let k=0;k<K;k++)sd[k]+=(X[i*K+k]-mu[k])**2;for(let k=0;k<K;k++)sd[k]=Math.sqrt(sd[k]/n)||1;
  const Z=new Float64Array(n*K);for(let i=0;i<n;i++)for(let k=0;k<K;k++)Z[i*K+k]=(X[i*K+k]-mu[k])/sd[k];
  let base=0;for(let i=0;i<n;i++)base+=y[i];base=clip(base/n,.01,.99);
  const w=new Float64Array(K),g=new Float64Array(K);let b=Math.log(base/(1-base));const lr=.8,lam=2e-3;
  for(let it=0;it<iters;it++){g.fill(0);let gb=0;
    for(let i=0;i<n;i++){let s=b;for(let k=0;k<K;k++)s+=w[k]*Z[i*K+k];const e=1/(1+Math.exp(-s))-y[i];gb+=e;for(let k=0;k<K;k++)g[k]+=e*Z[i*K+k]}
    b-=lr*gb/n;for(let k=0;k<K;k++)w[k]-=lr*(g[k]/n+lam*w[k]);}
  return{w:Array.from(w),b,mu:Array.from(mu),sd:Array.from(sd),base};
}
function predict(m,x){let s=m.b;for(let k=0;k<m.w.length;k++)s+=m.w[k]*(x[k]-m.mu[k])/m.sd[k];return 1/(1+Math.exp(-s))}
function contrib(m,x){return x.map((v,k)=>m.w[k]*(v-m.mu[k])/m.sd[k])}

// src: Kursverlauf je Markt; stride: nur jede n-te Kerze verwenden (bei sehr langem Verlauf)
async function trainModel(src=data,stride=1){
  setStat('Lerne aus der Vergangenheit: sammle Beispiele…','');await tick();
  const S=[];const H=horBars();
  for(const mk of Object.keys(src)){const d=src[mk];for(let i=210;i<d.c.length-H;i+=stride){if(!d.A[i])continue;const o=outcome(d,i);S.push({mk,ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r})}}
  if(S.length<500)throw new Error('zu wenig Verlaufsdaten zum Lernen');
  S.sort((a,b)=>a.ts-b.ts);
  const n=S.length,cut=Math.floor(n*.75);
  const X=new Float64Array(n*K),Y=new Float64Array(n);S.forEach((s,i)=>{for(let k=0;k<K;k++)X[i*K+k]=s.x[k];Y[i]=s.y});
  setStat(`Trainiere Testmodell auf ${cut.toLocaleString('de-CH')} historischen Signalen…`,'');await tick();
  const ev=fit(X,Y,cut);
  // Test auf den jüngsten 25 %, die das Modell nicht gesehen hat
  const test=S.slice(cut).map(s=>({...s,p:predict(ev,s.x)})).sort((a,b)=>a.p-b.p);
  const nb=10,buckets=[];for(let q=0;q<nb;q++){const part=test.slice(Math.floor(q*test.length/nb),Math.floor((q+1)*test.length/nb));buckets.push({n:part.length,win:part.reduce((s,x)=>s+x.y,0)/part.length,r:part.reduce((s,x)=>s+x.r,0)/part.length})}
  const baseWin=test.reduce((s,x)=>s+x.y,0)/test.length,baseR=test.reduce((s,x)=>s+x.r,0)/test.length;
  // Coin-spezifische Bilanz der besten 30 % Signale im Testzeitraum
  const thr=test[Math.floor(test.length*.7)].p,coin={};
  test.forEach(s=>{if(s.p<thr)return;const c=coin[s.mk]||(coin[s.mk]={n:0,w:0,r:0});c.n++;c.w+=s.y;c.r+=s.r});
  setStat(`Trainiere finales Modell auf allen ${n.toLocaleString('de-CH')} Signalen…`,'');await tick();
  const fin=fit(X,Y,n);
  const allP=[];for(let i=0;i<n;i+=Math.max(1,Math.floor(n/4000)))allP.push(predict(fin,S[i].x));allP.sort((a,b)=>a-b);
  const from=new Date(S[0].ts),to=new Date(S[n-1].ts);
  model={...fin,buckets,allP,baseWin,baseR,coin,n,ntest:test.length,from,to,tf:TF,trained:Date.now(),
    top:buckets[nb-1],top2:{win:(buckets[nb-1].win+buckets[nb-2].win)/2,r:(buckets[nb-1].r+buckets[nb-2].r)/2}};
  lastTrain=Date.now();
}
// Live-Wahrscheinlichkeit → Perzentil → erwarteter Gewinn aus dem Out-of-Sample-Test
function calib(p){const a=model.allP;let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;a[m]<p?lo=m+1:hi=m}const q=Math.min(9,Math.floor(lo/a.length*10));return{q,...model.buckets[q]}}

/* ---------- Analyse eines Markts ---------- */
function analyze(m,d){
  const N=d.c.length-1,last=d.c[N],x=feat(d,N),p=predict(model,x),cal=calib(p),ev=cal.r;
  const ct=contrib(model,x),reasons=[];
  ACTIVE.forEach((F,k)=>{const active=F.num?Math.abs(ct[k])>.04:x[k]!==0;if(active)reasons.push([ct[k],F.t(x[k],d,N)])});
  reasons.sort((a,b)=>Math.abs(b[0])-Math.abs(a[0]));
  const lb=SRBARS[TF],sup=Math.min(...d.l.slice(-lb)),res=Math.max(...d.h.slice(-lb)),a=d.A[N];
  const R=riskOf(last,a),stop=last-R,t1=last+GEO.tp*R,t2=Math.max(res,last+(GEO.tp+1)*R);
  const sig=ev>=.25?[2,'Starker Kauf']:ev>=.08?[1,'Kauf']:ev>-.08?[0,'Neutral']:ev>-.25?[-1,'Meiden']:[-2,'Stark meiden'];
  return{p,cal,ev,score:Math.round(clip(ev*100,-100,100)),sig,reasons,rsi:d.R[N],atrPct:a/last*100,volR:d.vr[N],sup,res,stop,t1,t2,
    trend:last>d.e50[N]?(d.e20[N]>d.e50[N]?'aufwärts':'erholt'):(d.e20[N]<d.e50[N]?'abwärts':'schwach'),d};
}


let TF=process.env.TF||'1h', markets=[], data={}, results={}, model=null, lastTrain=0;
const setStat=t=>console.log(t), tick=async()=>{};

const TOPIC=(process.env.NTFY_TOPIC||'').trim();
const CMD=TOPIC?TOPIC+'-cmd':'';                         // Kanal für Kauf/Verkauf-Eingaben aus der App
const LEVEL=+(process.env.MIN_LEVEL||2);                 // 2 = nur Starker Kauf, 1 = ab Kauf
const LOG=process.env.LOG_DIR||'logdata', T0=Date.now();
const DAY_MS=864e5;

/* ---------- Zustand: verschlüsselt im Logbuch (nur mit deinem ntfy-Kanal lesbar) ---------- */
const STATE_FILE=LOG+'/zustand.enc';
const KEY=TOPIC?crypto.scryptSync(TOPIC,'bitvavo-ag-push',32):null;
let st={notified:{},pos:{},ok:true,cmdSince:null,last3m:{},closed:[]};
function loadState(){
  if(!KEY||!fs.existsSync(STATE_FILE))return console.log('Kein gespeicherter Zustand, erster Lauf.');
  try{const b=Buffer.from(fs.readFileSync(STATE_FILE,'utf8'),'base64'),iv=b.subarray(0,12),tag=b.subarray(12,28);
    const dc=crypto.createDecipheriv('aes-256-gcm',KEY,iv);dc.setAuthTag(tag);
    st={...st,...JSON.parse(Buffer.concat([dc.update(b.subarray(28)),dc.final()]).toString('utf8'))}}
  catch(e){console.warn('Zustand nicht lesbar (anderer ntfy-Kanal?), starte neu:',e.message)}
}
function saveState(){
  if(!KEY)return;fs.mkdirSync(LOG,{recursive:true});
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',KEY,iv),ct=Buffer.concat([c.update(JSON.stringify(st),'utf8'),c.final()]);
  fs.writeFileSync(STATE_FILE,Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64'));
}

// Bitvavo erlaubt 1000 Abfragen pro Minute; der Bot hält Abstand und bremst, wenn das Limit naht
const BV_GAP=+(process.env.BV_GAP_MS||110), sleep=ms=>new Promise(r=>setTimeout(r,ms));let bvNext=0,bvCount=0;
async function j(url,tries=4){
  for(let t=0;t<tries;t++){
    if(url.startsWith(API)){const now=Date.now(),at=Math.max(now,bvNext);bvNext=at+BV_GAP;bvCount++;if(at>now)await sleep(at-now)}
    try{const r=await fetch(url);
      const rem=+(r.headers?.get?.('bitvavo-ratelimit-remaining')??NaN),reset=+(r.headers?.get?.('bitvavo-ratelimit-resetat')??NaN);
      if(Number.isFinite(rem)&&rem<150){const w=Math.min(65e3,Math.max(1e3,(Number.isFinite(reset)?reset-Date.now():30e3)+500));console.log(`Bitvavo-Limit fast erreicht (${rem} übrig), pausiere ${(w/1e3).toFixed(0)} s`);bvNext=Math.max(bvNext,Date.now()+w)}
      if(r.ok)return r.json();
      if(r.status===429){bvNext=Math.max(bvNext,Date.now()+20e3);continue}
      if(r.status<500){const e=new Error(url.split('?')[0]+' → '+r.status);e.fatal=true;throw e}}
    catch(e){if(e.fatal||t===tries-1)throw e}
    await sleep(1500*(t+1))}
  throw new Error(url.split('?')[0]+' nicht erreichbar')}
async function pool(items,n,fn){let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const it=items[i++];try{await fn(it)}catch(e){console.warn(it.market,e.message)}}}))}
async function push(title,message,prio=4,tag='chart_with_upwards_trend'){
  console.log('PUSH',title,'|',message);
  if(!TOPIC)return;
  const r=await fetch('https://ntfy.sh/',{method:'POST',body:JSON.stringify({topic:TOPIC,title,message,priority:prio,tags:[tag]})});
  if(!r.ok)console.warn('ntfy',r.status,await r.text());
}

/* ---------- Kauf/Verkauf-Eingaben: aus der Radar-App oder per Text in ntfy ---------- */
const num=s=>parseFloat(String(s).replace(/['’\s]/g,'').replace(',','.'));
const confirmations=[];
async function readCommands(){
  if(!CMD)return;
  const since=st.cmdSince||'12h';
  const r=await fetch(`https://ntfy.sh/${CMD}/json?poll=1&since=${encodeURIComponent(since)}`);
  if(!r.ok)return console.warn('ntfy-Befehle',r.status);
  const msgs=(await r.text()).split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(m=>m&&m.event==='message');
  for(const m of msgs){
    st.cmdSince=m.id;const t=(m.message||'').trim();let x;
    if(x=t.match(/^(kauf|kaufen|gekauft|buy)\s+([a-z0-9]+)(?:-eur)?\s+([\d'.,]+)(?:\s+([\d'.,]+))?/i)){
      const mk=x[2].toUpperCase()+'-EUR',buy=num(x[3]),qty=x[4]?num(x[4]):null;
      if(buy>0){st.pos[mk]={buy,qty,t:m.time*1000};delete st.notified['s:'+mk];confirmations.push({kind:'add',mk})}
    }else if(x=t.match(/^(verkauf|verkaufen|verkauft|sell)\s+([a-z0-9]+)(?:-eur)?(?:\s+([\d'.,]+))?/i)){
      const mk=x[2].toUpperCase()+'-EUR',p=st.pos[mk];
      if(p){const sell=x[3]?num(x[3]):null;st.closed.push({m:mk,buy:p.buy,sell,t:p.t,end:m.time*1000});st.closed=st.closed.slice(-200);
        delete st.pos[mk];delete st.notified['s:'+mk];confirmations.push({kind:'del',mk,sell,buy:p.buy})}
      else confirmations.push({kind:'unknown',mk});
    }else if(/^(liste|status|positionen)$/i.test(t))confirmations.push({kind:'list'});
    else confirmations.push({kind:'help',t});
  }
}

function advice(mk,p,last){
  const r=results[mk],a=r?r.d.A[r.d.c.length-1]:last*0.02;
  const pnl=(last/p.buy-1)*100,eur=p.qty?(last-p.buy)*p.qty:null;
  const R=riskOf(p.buy,a),trail=p.high>=p.buy+R?p.high-R:-Infinity,eff=Math.max(p.tpHit?Math.max(p.stop,p.buy):p.stop,trail),o={pnl,eur,eff,last};
  if(last<=eff)return{...o,act:'stop',label:'Verkaufen',why:eff>=p.buy?`Nachlaufender Stop bei ${fmtP(eff)} € unterschritten, Gewinn sichern`:`Stop-Loss bei ${fmtP(eff)} € erreicht, Verlust begrenzen`};
  if(last>=p.tp)return{...o,act:'take',label:'Gewinn mitnehmen',why:`Ziel ${fmtP(p.tp)} € erreicht: etwa die Hälfte verkaufen, Stop für den Rest auf Einstand ${fmtP(p.buy)} €`};
  if(r&&r.cal.q<=1)return{...o,act:'signal',label:'Verkaufen',why:`Modell zählt ${mk.replace('-EUR','')} jetzt zu den schwächsten 20 % aller Coins`};
  if(r&&pnl>0&&r.rsi>75)return{...o,act:'secure',label:'Teilgewinn sichern',why:`RSI ${r.rsi.toFixed(0)} stark überkauft`};
  return{...o,act:'hold',label:'Halten',why:`Stop ${fmtP(eff)} €, Ziel ${fmtP(p.tp)} €`};
}

/* ---------- Logbuch ----------
   Kurse:   1 Min bis 30 Tage → 5 Min bis 3 Monate → 30 Min bis 6 Monate → 1 h bis 1 Jahr → 24 h bis 3 Jahre → gelöscht
   Signale: jeder Lauf bis 30 Tage → 1 h bis 1 Jahr → 24 h bis 3 Jahre → gelöscht
   Alter = Alter der Daten. Die jeweils neueste Stufe liegt in Stundendateien, ältere in gepackten Tagesdateien. */
const TIERS={
  kurse:[{res:1,dir:'kurse/1m',days:30},{res:5,dir:'kurse/5m',days:91},{res:30,dir:'kurse/30m',days:182},{res:60,dir:'kurse/1h',days:365},{res:1440,dir:'kurse/24h',days:1095}],
  signale:[{res:0,dir:'signale/lauf',days:30},{res:60,dir:'signale/1h',days:365},{res:1440,dir:'signale/24h',days:1095}],
};
const iso=ts=>new Date(ts).toISOString().slice(0,16).replace('T',' ');
const dayOf=ts=>new Date(ts).toISOString().slice(0,10);
const csvq=v=>{v=v==null?'':String(v);return /[",\n;]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
function appendCsv(rel,header,rows){
  if(!rows.length)return;const f=LOG+'/'+rel;fs.mkdirSync(path.dirname(f),{recursive:true});
  if(!fs.existsSync(f))fs.writeFileSync(f,header.join(',')+'\n');
  fs.appendFileSync(f,rows.map(r=>r.map(csvq).join(',')).join('\n')+'\n');
}
const hourFile=(dir,ts)=>{const t=iso(ts);return `${dir}/${t.slice(0,7)}/${t.slice(0,10)}-${t.slice(11,13)}.csv`};
const HK=['zeit_utc','markt','open','high','low','close','volumen'];
const HS=['zeit_utc','markt','preis_eur','volumen_24h_eur','volumen_3t_eur','veraenderung_24h_pct','rsi','treffer_wahrsch','erwartung_r','signal'];
// 1-Minuten-Kerzen aller Märkte der Beobachtungsliste seit dem letzten Lauf
async function log1m(){
  const now=Date.now(),byFile={};st.last1m=st.last1m||{};
  await pool(markets.filter(eligible),5,async m=>{
    const last=st.last1m[m.market]||st.last3m?.[m.market]||now-60*60e3;
    const lim=Math.round(clip((now-last)/60e3+5,5,1440));
    const c=(await j(`${API}/${m.market}/candles?interval=1m&limit=${lim}`)).slice().reverse();
    for(const k of c){const ts=+k[0];if(ts<=last||ts+60e3>now-5e3)continue;
      (byFile[hourFile(TIERS.kurse[0].dir,ts)]||(byFile[hourFile(TIERS.kurse[0].dir,ts)]=[])).push([iso(ts),m.market,k[1],k[2],k[3],k[4],k[5]]);
      st.last1m[m.market]=Math.max(st.last1m[m.market]||0,ts)}
  });
  let n=0;for(const f of Object.keys(byFile).sort()){byFile[f].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);appendCsv(f,HK,byFile[f]);n+=byFile[f].length}
  console.log(`${n} neue 1-Minuten-Werte geloggt.`);
}
function logRun(buys){
  const now=Date.now(),t=iso(now),mon=t.slice(0,7),all=Object.values(results);
  appendCsv(hourFile(TIERS.signale[0].dir,now),HS,markets.filter(m=>results[m.market]&&eligible(m)).map(m=>{const r=results[m.market];return[t,m.market,m.last,Math.round(m.vol),Math.round(m.vol3d),m.chg.toFixed(2),r.rsi.toFixed(1),r.p.toFixed(3),r.ev.toFixed(3),r.sig[1]]}));
  appendCsv(`laeufe/${mon}.csv`,['zeit_utc','zeiteinheit','maerkte','kauf_signale','meiden','modell_signale','basis_trefferquote','top10_trefferquote','top10_ergebnis_r','btc_eur','dauer_s'],
    [[t,TF,markets.filter(eligible).length,all.filter(r=>r.sig[0]>0).length,all.filter(r=>r.sig[0]<0).length,model.n,model.baseWin.toFixed(3),model.top.win.toFixed(3),model.top.r.toFixed(3),markets.find(m=>m.market==='BTC-EUR')?.last??'',((now-T0)/1000).toFixed(0)]]);
  appendCsv(`meldungen/${mon}.csv`,['zeit_utc','titel','text'],buys.map(b=>[t,b.t,b.b]));
}

/* ---------- Aufräumen und Verdichten ---------- */
function files(dir){const out=[];if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='.git')continue;const p=dir+'/'+e.name;if(e.isDirectory())out.push(...files(p));else out.push(p)}return out}
function readCsv(p){const t=p.endsWith('.gz')?zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'):fs.readFileSync(p,'utf8');const [h,...r]=t.trim().split('\n');return{h,rows:r.filter(Boolean)}}
const bucket=(t,res)=>{if(res>=1440)return t.slice(0,10)+' 00:00';const mins=+t.slice(11,13)*60+ +t.slice(14,16),b=Math.floor(mins/res)*res;return t.slice(0,11)+String(Math.floor(b/60)).padStart(2,'0')+':'+String(b%60).padStart(2,'0')};
const nfmt=v=>String(+(+v).toPrecision(10));
function aggregate(kind,rows,res){
  const out=new Map();
  for(const r of rows.slice().sort()){const c=r.split(','),k=bucket(c[0],res)+'|'+c[1],x=out.get(k);
    if(kind==='signale'){if(!x)out.set(k,[bucket(c[0],res),...c.slice(1)]);continue}
    if(!x)out.set(k,[bucket(c[0],res),c[1],+c[2],+c[3],+c[4],+c[5],+c[6]]);
    else{x[3]=Math.max(x[3],+c[3]);x[4]=Math.min(x[4],+c[4]);x[5]=+c[5];x[6]+=+c[6]}}
  return [...out.values()].map(x=>kind==='signale'?x.join(','):[x[0],x[1],...x.slice(2).map(nfmt)].join(','));
}
function writeDay(dir,day,h,rows){
  const f=`${LOG}/${dir}/${day.slice(0,4)}/${day}.csv.gz`;fs.mkdirSync(path.dirname(f),{recursive:true});
  if(fs.existsSync(f)){const old=readCsv(f);rows=[...old.rows,...rows]}
  fs.writeFileSync(f,zlib.gzipSync([h,...rows].join('\n')+'\n',{level:9}));
}
function housekeeping(){
  const now=Date.now(),curHour=hourFile('',now).slice(-17,-4);let packed=0,thinned=0,deleted=0;
  // Abgeschlossene Stundendateien packen
  for(const p of files(LOG)){const m=path.basename(p).match(/^(\d{4}-\d{2}-\d{2}-\d{2})\.csv$/);if(m&&m[1]<curHour){fs.writeFileSync(p+'.gz',zlib.gzipSync(fs.readFileSync(p),{level:9}));fs.unlinkSync(p);packed++}}
  // Ältere Stufen verdichten bzw. löschen
  for(const [kind,tiers] of Object.entries(TIERS)){
    tiers.forEach((tier,i)=>{
      const cut=dayOf(now-tier.days*DAY_MS),byDay={};
      for(const p of files(`${LOG}/${tier.dir}`)){const m=path.basename(p).match(/^(\d{4}-\d{2}-\d{2})/);if(m&&m[1]<cut)(byDay[m[1]]||(byDay[m[1]]=[])).push(p)}
      for(const [day,ps] of Object.entries(byDay)){
        const next=tiers[i+1];
        if(next){let h='',rows=[];for(const p of ps){const x=readCsv(p);h=x.h;rows.push(...x.rows)}writeDay(next.dir,day,h,aggregate(kind,rows,next.res));thinned++}
        else deleted++;
        ps.forEach(p=>fs.unlinkSync(p));
      }
    });
  }
  // Übernahme aus älteren Versionen des Bots
  for(const p of files(`${LOG}/kurse/3min`)){const x=readCsv(p),day=path.basename(p).slice(0,10);writeDay('kurse/5m',day,x.h,aggregate('kurse',x.rows,5));fs.unlinkSync(p);thinned++}
  for(const p of files(`${LOG}/signale`).filter(p=>/signale\/\d{4}\//.test(p))){const x=readCsv(p),day=path.basename(p).slice(0,10);writeDay('signale/1h',day,x.h,aggregate('signale',x.rows,60));fs.unlinkSync(p);thinned++}
  for(const p of files(`${LOG}/markt`)){fs.unlinkSync(p);deleted++}
  // Monatsdateien (Läufe, Meldungen) nach 3 Jahren löschen
  const cutMon=dayOf(now-1095*DAY_MS).slice(0,7);
  for(const p of [...files(`${LOG}/laeufe`),...files(`${LOG}/meldungen`)]){const m=path.basename(p).match(/^(\d{4}-\d{2})\.csv/);if(m&&m[1]<cutMon){fs.unlinkSync(p);deleted++}}
  const prune=d=>{if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory()&&e.name!=='.git'){prune(d+'/'+e.name);if(!fs.readdirSync(d+'/'+e.name).length)fs.rmdirSync(d+'/'+e.name)}};prune(LOG);
  if(packed||thinned||deleted)console.log(`Aufgeräumt: ${packed} Stunden gepackt, ${thinned} Tage verdichtet, ${deleted} gelöscht.`);
}

/* ---------- Langzeitverlauf: 12 Monate Kerzen je Markt, zwischengespeichert im Runner ---------- */
const HIST_DAYS=+(process.env.HIST_DAYS||365), CACHE=process.env.CACHE_DIR||'verlauf', LONG_V=1;
// Lädt [start,end] in Fenstern zu höchstens 1440 Kerzen (unabhängig von der Sortierung der Antwort)
async function fetchRange(mk,start,end,map){
  const step=TFH[TF]*36e5,W=1440*step;let n=0;
  for(let s=Math.floor(start);s<end;s+=W){const e=Math.min(Math.floor(end),s+W-1);
    const rows=await j(`${API}/${mk}/candles?interval=${TF}&limit=1440&start=${s}&end=${e}`);
    if(Array.isArray(rows))for(const r of rows){const t=+r[0];if(t>=start&&t<=end){map.set(t,[t,+r[1],+r[2],+r[3],+r[4],+r[5]]);n++}}}
  return n;
}
async function history(mk){
  const now=Date.now(),from=now-HIST_DAYS*DAY_MS,f=`${CACHE}/${TF}/${mk}.json.gz`;
  let c={full:false,rows:[]};try{c=JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'))}catch(e){}
  const map=new Map();for(const r of c.rows)if(r[0]>=from)map.set(r[0],r);
  if(!c.full||!map.size)await fetchRange(mk,from,now,map);                 // erstmals: ganzes Jahr
  else await fetchRange(mk,Math.max(...map.keys()),now,map);               // danach: nur Neues
  const rows=[...map.values()].sort((a,b)=>a[0]-b[0]);
  fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,zlib.gzipSync(JSON.stringify({full:true,rows})));
  return rows;
}
function packModel(m){
  const q=m.allP,N=Math.min(1000,q.length),allP=Array.from({length:N},(_,i)=>+q[Math.round(i*(q.length-1)/Math.max(1,N-1))].toFixed(6));
  return{w:m.w,b:m.b,mu:m.mu,sd:m.sd,base:m.base,buckets:m.buckets,allP,baseWin:m.baseWin,baseR:m.baseR,coin:m.coin,n:m.n,ntest:m.ntest,
    from:new Date(m.from).toISOString(),to:new Date(m.to).toISOString(),tf:m.tf,trained:m.trained,top:m.top,top2:m.top2,merkmale:FEATSET,tage:HIST_DAYS};
}
// Einmal täglich: 12 Monate laden, wöchentliche Analysen, Modell trainieren und veröffentlichen
async function longTrain(){
  const t0=Date.now(),c0=bvCount;st.longTryAt=t0;
  const list=markets.filter(eligible).map(m=>m.market);if(!list.includes('BTC-EUR'))list.push('BTC-EUR');
  const hist={};let bars=0;
  await pool(list,3,async mk=>{const rows=await history(mk);if(rows.length>=300){hist[mk]=prep(rows);bars+=rows.length}});
  const mk=Object.keys(hist).length;
  console.log(`Langzeitverlauf: ${mk} Märkte, ${bars.toLocaleString('de-CH')} Kerzen (${HIST_DAYS} Tage), ${bvCount-c0} Abfragen, ${((Date.now()-t0)/1e3).toFixed(0)} s.`);
  if(!hist['BTC-EUR']||mk<10)throw new Error('Langzeitverlauf unvollständig');
  setBtc(hist);
  if(!st.geoAt||Date.now()-st.geoAt>7*DAY_MS)await geoAnalysis(hist);
  if(!st.featAt||Date.now()-st.featAt>7*DAY_MS)await featureAB(hist);
  setFeatSet(st.featSet||'v1');
  const t1=Date.now();
  await trainModel(hist,Math.max(1,Math.round(bars/450000)));
  st.model=packModel(model);st.modelAt=Date.now();
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  fs.writeFileSync(LOG+'/analyse/modell.json',JSON.stringify({...st.model,merkmal_namen:ACTIVE.map(F=>F.n),gebuehr_pro_seite:FEE}));
  console.log(`Langzeitmodell: ${model.n.toLocaleString('de-CH')} Signale, ${model.from.toISOString().slice(0,10)} bis ${model.to.toISOString().slice(0,10)}, Basis ${(model.baseWin*100).toFixed(0)} %, Top-10 % ${(model.top.win*100).toFixed(0)} % / ${fmtR(model.top.r)} (${((Date.now()-t1)/1e3).toFixed(0)} s)`);
  setBtc();
}

/* ---------- Welcher Trade-Aufbau lohnt sich nach Gebühren? (einmal pro Woche) ---------- */
async function geoAnalysis(src=data){
  const t0=Date.now(),S=[],tail=Math.round(48/TFH[TF]),D=Object.values(src),stride=Math.max(1,Math.round(D.reduce((s,d)=>s+d.c.length,0)/150000));
  for(const d of D)for(let i=210;i<d.c.length-tail;i+=stride)if(d.A[i])S.push({d,i,ts:d.ts[i],x:feat(d,i)});
  if(S.length<2000)return console.log('Zu wenig Daten für die Aufbau-Analyse.');
  S.sort((a,b)=>a.ts-b.ts);const n=S.length,cut=Math.floor(n*.75),X=new Float64Array(n*K);
  S.forEach((s,i)=>{for(let k=0;k<K;k++)X[i*K+k]=s.x[k]});
  const res=[];
  for(const sl of [1,1.5,2,3])for(const minRisk of [0,0.015,0.025])for(const tp of [1.5,2,3])for(const h of [8,24,48]){
    const g={sl,minRisk,tp,h},Y=new Float64Array(n),Rr=new Float64Array(n);
    S.forEach((s,i)=>{const o=outcomeG(s.d,s.i,g);Y[i]=o.y;Rr[i]=o.r});
    const m=fit(X,Y,cut,60),test=[];for(let i=cut;i<n;i++)test.push([predict(m,S[i].x),Rr[i],Y[i]]);
    test.sort((a,b)=>b[0]-a[0]);
    const top=f=>{const t=test.slice(0,Math.max(1,Math.floor(test.length*f)));return{r:t.reduce((s,x)=>s+x[1],0)/t.length,w:t.reduce((s,x)=>s+x[2],0)/t.length,n:t.length}};
    const t10=top(.1),t20=top(.2),all=top(1);
    res.push({...g,base_r:all.r,top10_r:t10.r,top10_win:t10.w,top20_r:t20.r,top10_n:t10.n,score:(t10.r+t20.r)/2});
  }
  res.sort((a,b)=>b.score-a.score);
  const best=res[0];st.geo={sl:best.sl,minRisk:best.minRisk,tp:best.tp,h:best.h};st.geoAt=Date.now();GEO={...GEO,...st.geo};
  const days=Math.round((S[n-1].ts-S[0].ts)/DAY_MS);
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  fs.writeFileSync(LOG+'/analyse/geometrie.csv',['stop_atr,min_risiko_pct,ziel_r,haltedauer_h,erwartung_alle_r,erwartung_top10_r,trefferquote_top10,erwartung_top20_r,anzahl_top10',
    ...res.map(r=>[r.sl,r.minRisk*100,r.tp,r.h,r.base_r.toFixed(3),r.top10_r.toFixed(3),r.top10_win.toFixed(3),r.top20_r.toFixed(3),r.top10_n].join(','))].join('\n')+'\n');
  const af=LOG+'/analyse/aktuell.json';let ak={};try{ak=JSON.parse(fs.readFileSync(af,'utf8'))}catch(e){}
  fs.writeFileSync(af,JSON.stringify({...ak,merkmale:st.featSet||'v1',geo:st.geo,gemessen:new Date().toISOString(),zeiteinheit:TF,tage_daten:days,beispiele:n,
    erwartung_top10_r:+best.top10_r.toFixed(3),trefferquote_top10:+best.top10_win.toFixed(3),gebuehr_pro_seite:FEE},null,1));
  console.log(`Aufbau-Analyse (${res.length} Varianten, ${((Date.now()-t0)/1000).toFixed(0)} s): bester Aufbau Stop ${best.sl} ATR / min ${best.minRisk*100}%, Ziel ${best.tp} R, ${best.h} h → Top-10 % ${fmtR(best.top10_r)}`);
  // Nur bei einem Wechsel melden: Vorteil verloren oder wiedergewonnen
  const edge=best.top10_r>0;
  if(edge!==st.edge){
    if(!edge)await push('Kein Vorteil nach Gebühren','Auch der beste getestete Trade-Aufbau verliert nach Gebühren im Schnitt. Bis sich das ändert, kommen kaum Kauf-Signale.',3,'warning');
    else if(st.edge===false)await push('Wieder ein Vorteil nach Gebühren',`Die besten 10 % der Signale brachten zuletzt im Schnitt ${fmtR(best.top10_r)} pro Trade nach Gebühren. Kauf-Signale sind wieder möglich.`,3,'chart_with_upwards_trend');
    st.edge=edge}
}

/* ---------- Rückblick: Hätte das Modell die Gewinner der letzten 24h erkannt? (stündlich) ---------- */
function retro(){
  const now=Date.now(),hour=new Date(now).toISOString().slice(0,13);
  if(st.lastRetro===hour)return;st.lastRetro=hour;
  const H=Math.round(24/TFH[TF]),cut=now-26*36e5,hb=horBars();
  const movers=markets.filter(m=>eligible(m)&&data[m.market]&&Math.abs(m.chg)>=10);
  if(!movers.length)return;
  // Modell nur mit Daten trainieren, die VOR dem Rückblick-Zeitraum lagen
  const S=[];for(const d of Object.values(data))for(let i=210;i<d.c.length-hb;i++)if(d.A[i]&&d.ts[i]+hb*TFH[TF]*36e5<cut)S.push({x:feat(d,i),y:outcome(d,i).y});
  if(S.length<2000)return;
  const n=S.length,X=new Float64Array(n*K),Y=new Float64Array(n);S.forEach((s,i)=>{for(let k=0;k<K;k++)X[i*K+k]=s.x[k];Y[i]=s.y});
  const mp=fit(X,Y,n,120),allP=[];for(let i=0;i<n;i+=Math.max(1,Math.floor(n/3000)))allP.push(predict(mp,S[i].x));allP.sort((a,b)=>a-b);
  const evOf=p=>{let lo=0,hi=allP.length;while(lo<hi){const m=(lo+hi)>>1;allP[m]<p?lo=m+1:hi=m}return model.buckets[Math.min(9,Math.floor(lo/allP.length*10))].r};
  const rows=[];
  for(const m of movers){const d=data[m.market],N=d.c.length-1;let best=null;
    for(let i=N-H;i<N;i++){const p=predict(mp,feat(d,i)),ev=evOf(p);if(!best||ev>best.ev||(ev===best.ev&&p>best.p))best={i,p,ev}}
    const sig=best.ev>=.25?'Starker Kauf':best.ev>=.08?'Kauf':best.ev>-.08?'Neutral':'Meiden';
    rows.push([hour,m.market,m.chg.toFixed(1),iso(d.ts[best.i]),best.p.toFixed(3),best.ev.toFixed(3),sig,d.c[best.i],d.c[N],((d.c[N]/d.c[best.i]-1)*100).toFixed(1)]);}
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  const f=LOG+'/analyse/rueckblick.csv',head='erstellt_utc,markt,veraenderung_24h_pct,beste_stunde_utc,treffer_wahrsch,erwartung_r,signal_damals,kurs_damals,kurs_jetzt,seither_pct';
  const old=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').slice(1).filter(l=>l.slice(0,10)>=new Date(now-30*864e5).toISOString().slice(0,10)):[];
  fs.writeFileSync(f,[head,...old,...rows.map(r=>r.join(','))].join('\n')+'\n');
  console.log(`Rückblick: ${rows.length} Coins mit ±10 % in 24h ausgewertet.`);
}

/* ---------- Bisherige gegen erweiterte Merkmale: wöchentlicher Vergleich auf unbekannten Testdaten ---------- */
async function featureAB(src=data){
  const t0=Date.now();setFeatSet('v2');
  const all=FEATS.length,v1=FEATS.map((F,k)=>F.v2?-1:k).filter(k=>k>=0),S=[],hb=horBars(),D=Object.values(src),stride=Math.max(1,Math.round(D.reduce((s,d)=>s+d.c.length,0)/400000));
  for(const d of D)for(let i=210;i<d.c.length-hb;i+=stride)if(d.A[i]){const o=outcome(d,i);S.push({ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r})}
  if(S.length<2000){setFeatSet(st.featSet||'v1');return console.log('Zu wenig Daten für den Merkmal-Vergleich.')}
  S.sort((a,b)=>a.ts-b.ts);const n=S.length,cut=Math.floor(n*.75);
  const score=cols=>{const k=cols.length,X=new Float64Array(n*k),Y=new Float64Array(n);
    S.forEach((s,i)=>{cols.forEach((c,j)=>X[i*k+j]=s.x[c]);Y[i]=s.y});
    const m=fit(X,Y,cut,120,k),t=[];for(let i=cut;i<n;i++)t.push([predict(m,cols.map(c=>S[i].x[c])),S[i].r,S[i].y]);t.sort((a,b)=>b[0]-a[0]);
    const top=f=>{const q=t.slice(0,Math.max(1,Math.floor(t.length*f)));return{r:q.reduce((s,x)=>s+x[1],0)/q.length,w:q.reduce((s,x)=>s+x[2],0)/q.length}};
    const a=top(.1),b=top(.2);return{top10_r:a.r,top10_win:a.w,top20_r:b.r,score:(a.r+b.r)/2}};
  const A=score(v1),B=score(FEATS.map((_,k)=>k));
  const win=B.score>A.score+0.01?'v2':'v1';st.featSet=win;st.featAt=Date.now();setFeatSet(win);
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  const f=LOG+'/analyse/merkmale.csv',head='datum_utc,variante,anzahl_merkmale,erwartung_top10_r,trefferquote_top10,erwartung_top20_r,gewaehlt';
  const old=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').slice(1):[];const d=iso(Date.now());
  fs.writeFileSync(f,[head,...old,[d,'bisher',v1.length,A.top10_r.toFixed(3),A.top10_win.toFixed(3),A.top20_r.toFixed(3),win==='v1'?'ja':'nein'].join(','),[d,'erweitert',all,B.top10_r.toFixed(3),B.top10_win.toFixed(3),B.top20_r.toFixed(3),win==='v2'?'ja':'nein'].join(',')].join('\n')+'\n');
  const af=LOG+'/analyse/aktuell.json';let ak={};try{ak=JSON.parse(fs.readFileSync(af,'utf8'))}catch(e){}
  fs.writeFileSync(af,JSON.stringify({...ak,geo:st.geo||ak.geo,merkmale:win,merkmale_vergleich:{bisher:+A.score.toFixed(3),erweitert:+B.score.toFixed(3),gemessen:new Date().toISOString()}},null,1));
  console.log(`Merkmal-Vergleich (${((Date.now()-t0)/1000).toFixed(0)} s, ${n} Beispiele): bisher ${fmtR(A.score)}, erweitert ${fmtR(B.score)} → ${win==='v2'?'erweitert':'bisher'}`);
}

/* ---------- Hauptlauf ---------- */
async function main(){
  await readCommands().catch(e=>console.warn('Befehle',e.message));
  const t=await j(API+'/ticker/24h');
  const tick24=Object.fromEntries(t.map(x=>[x.market,x]));
  markets=t.filter(x=>x.market&&x.market.endsWith('-EUR')&&!STABLE.has(x.market.split('-')[0])&&+x.last>0&&(+x.volumeQuote>=MIN_VOL||st.pos[x.market]))
    .map(x=>({market:x.market,base:x.market.split('-')[0],last:+x.last,vol:+x.volumeQuote,chg:x.open>0?(x.last-x.open)/x.open*100:0}));
  console.log(`${markets.length} Märkte über 50k € in 24h, Zeiteinheit ${TF}, ${Object.keys(st.pos).length} eigene Positionen`);
  await pool(markets,5,async m=>{const rows=(await j(`${API}/${m.market}/candles?interval=${TF}&limit=${HIST}`)).slice().reverse();if(rows.length>=220)data[m.market]=prep(rows)});
  markets.forEach(m=>{if(data[m.market])m.vol3d=vol3d(data[m.market])});
  markets=markets.filter(m=>data[m.market]&&(eligible(m)||st.pos[m.market]));
  for(const k of Object.keys(data))if(!markets.find(m=>m.market===k))delete data[k];
  console.log(`${markets.filter(eligible).length} Märkte erfüllen den Filter (>50k €/24h, >250k €/3 Tage).`);
  await log1m().catch(e=>console.warn('1-Minuten-Log',e.message));
  // Umstellung auf 12 Monate: Analysen und Modell einmalig neu berechnen (die bekannte Warnung nicht erneut senden)
  if(st.longV!==LONG_V){st.longV=LONG_V;st.geoAt=0;st.featAt=0;st.model=null;if(st.edge===undefined&&st.geo)st.edge=false}
  if(st.geo)GEO={...GEO,...st.geo};
  setFeatSet(st.featSet||'v1');
  const due=!st.model||st.model.tf!==TF||st.model.merkmale!==(st.featSet||'v1')||Date.now()-(st.modelAt||0)>DAY_MS;
  if(due&&Date.now()-(st.longTryAt||0)>36e5){try{await longTrain()}catch(e){console.warn('Langzeit-Training fehlgeschlagen, nächster Versuch in 1 h:',e.message)}}
  if(st.geo)GEO={...GEO,...st.geo};
  setFeatSet(st.featSet||'v1');setBtc();
  if(st.model&&st.model.tf===TF&&st.model.merkmale===FEATSET&&st.model.w.length===K)model=st.model;
  else{console.log('Kein Langzeitmodell vorhanden, lerne vorerst aus den letzten Wochen.');await trainModel()}
  console.log(`Modell: ${model.n} Signale (${model.tage?model.tage+' Tage':'letzte Wochen'}), Basis ${(model.baseWin*100).toFixed(0)}%, Top-10% ${(model.top.win*100).toFixed(0)}%`);
  markets.forEach(m=>{if(data[m.market])results[m.market]=analyze(m,data[m.market])});

  const now=Date.now(),buys=[],sells=[];
  for(const m of markets){const r=results[m.market];if(!r||!eligible(m))continue;
    const key='b:'+m.market+':'+TF,on=r.sig[0]>=LEVEL,prev=st.notified[key];
    if(on&&!(prev&&prev.s))buys.push({t:`${r.sig[1]}: ${m.base} (${TF})`,b:`Kurs ${fmtP(m.last)} € · Treffer-W. ${(r.cal.win*100).toFixed(0)}% · Stop ${fmtP(r.stop)} € · Ziel ${fmtP(r.t1)} €`,ev:r.ev});
    st.notified[key]={s:on,t:now}}
  for(const [mk,p] of Object.entries(st.pos)){const tk=tick24[mk];if(!tk){console.warn('Kein Kurs für',mk);continue}
    const last=+tk.last,a=results[mk]?results[mk].d.A.at(-1):last*0.02;
    if(p.stop==null){const R=riskOf(p.buy,a);p.stop=p.buy-R;p.tp=p.buy+GEO.tp*R;p.high=Math.max(p.buy,last);p.tpHit=false}
    p.high=Math.max(p.high,last);
    const adv=advice(mk,p,last);if(last>=p.tp)p.tpHit=true;
    const key='s:'+mk,prev=st.notified[key];
    console.log(`Position ${mk}: ${adv.label} (${pct(adv.pnl)})`);
    if(adv.act!=='hold'&&!(prev&&prev.s===adv.act))sells.push({t:`${adv.label}: ${mk.replace('-EUR','')}`,b:`${adv.why}. ${pct(adv.pnl)} seit Kauf${adv.eur!=null?` (${adv.eur>=0?'+':''}${adv.eur.toFixed(2)} €)`:''}, Kurs ${fmtP(last)} €`});
    st.notified[key]={s:adv.act,t:now}}

  for(const c of confirmations){const b=c.mk?.replace('-EUR','');
    if(c.kind==='add'){const p=st.pos[c.mk];await push(`Kauf eingetragen: ${b}`,`Kaufpreis ${fmtP(p.buy)} €${p.qty?`, Menge ${p.qty}`:''}. Stop ${fmtP(p.stop)} €, Ziel ${fmtP(p.tp)} €. Ich melde mich, sobald du verkaufen solltest.`,3,'white_check_mark')}
    else if(c.kind==='del')await push(`Verkauf eingetragen: ${b}`,c.sell?`Ergebnis ${pct((c.sell/c.buy-1)*100)} (Kauf ${fmtP(c.buy)} €, Verkauf ${fmtP(c.sell)} €).`:'Position entfernt.',3,'white_check_mark');
    else if(c.kind==='unknown')await push(`${b} nicht im Bestand`,'Zu diesem Coin ist kein Kauf eingetragen.',2,'grey_question');
    else if(c.kind==='list'){const L=Object.entries(st.pos);await push('Deine Positionen',L.length?L.map(([mk,p])=>{const last=+(tick24[mk]?.last||0);return `${mk.replace('-EUR','')}: ${pct((last/p.buy-1)*100)} · ${advice(mk,p,last).label}`}).join('\n'):'Keine Positionen eingetragen.',2,'clipboard')}
    else await push('Befehl nicht verstanden',`«${c.t.slice(0,60)}». Beispiele: «kauf BTC 61500 0.02», «verkauf BTC 63000», «liste».`,2,'grey_question');
  }
  for(const s of sells)await push(s.t,s.b,5,'warning');
  buys.sort((a,b)=>b.ev-a.ev);
  for(const b of buys.slice(0,4))await push(b.t,b.b,4);
  if(buys.length>4)await push(`${buys.length-4} weitere Kauf-Signale`,buys.slice(4).map(b=>b.t.split(': ')[1]).join(', '),3);
  if(!st.ok)await push('Bitvavo-Bot läuft wieder','Daten werden wieder normal abgerufen.',2,'white_check_mark');
  st.ok=true;
  try{retro()}catch(e){console.warn('Rückblick',e.message)}
  logRun(buys);
  console.log(`Fertig: ${buys.length} neue Kauf-Signale, ${sells.length} Verkaufsmeldungen, ${confirmations.length} Eingaben.`);
}

loadState();
// Optional: Positionen weiterhin auch per Secret POSITIONS
try{for(const p of JSON.parse(process.env.POSITIONS||'[]')){const mk=(p.coin||'').toUpperCase().replace(/-EUR$/,'')+'-EUR';if(+p.buy>0&&!st.pos[mk])st.pos[mk]={buy:+p.buy,qty:p.qty?+p.qty:null,t:Date.now()}}}catch(e){}
try{await main()}
catch(e){console.error(e);if(st.ok)await push('Bitvavo-Bot: Fehler',String(e.message||e).slice(0,200),3,'x');st.ok=false;process.exitCode=1}
finally{try{housekeeping()}catch(e){console.warn('Aufräumen',e.message)}saveState()}
