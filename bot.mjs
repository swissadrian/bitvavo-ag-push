// Bitvavo Signal-Bot: prüft alle EUR-Märkte mit > 250k € Volumen, lernt aus dem Kursverlauf,
// schickt Kauf- und Verkaufssignale per ntfy und führt ein Logbuch. Gleiche Logik wie die Radar-App.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
const API='https://api.bitvavo.com/v2';
const CG='https://api.coingecko.com/api/v3';
const MIN_VOL=50000, MIN_VOL30=1000000;   // > 50k € am letzten Tag UND > 1 Mio. € in den letzten 30 Tagen
// Umsatz in € der letzten h Stunden aus den Kerzen; null, wenn die geladenen Kerzen dafür nicht weit genug zurückreichen
const volSum=(d,h)=>{const n=Math.round(h/TFH[TF]);if(d.c.length<n&&d.c.length>=HIST)return null;let s=0;for(let i=Math.max(0,d.c.length-n);i<d.c.length;i++)s+=d.v[i]*d.c[i];return s};
const vol3d=d=>volSum(d,72)??0;
const eligible=m=>m.vol>=MIN_VOL&&(m.vol30d??0)>=MIN_VOL30;
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
const fmtV=v=>v>=1e6?(v/1e6).toFixed(v>=1e7?0:1)+'M':(v/1e3).toFixed(0)+'K';
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
// Zusätzliche Daten, die Bitvavo-Kerzen nicht enthalten: Fear & Greed (Tag), Orderbuch je Markt (Stunde), CoinGecko-Marktdaten (Stunde)
const EXT={fg:new Map(),ob:new Map(),cg:new Map()},HOUR=36e5,DAYMS=864e5;
function fgAt(ts){const v=EXT.fg.get(Math.floor(ts/DAYMS)*DAYMS);return v==null?null:v}
function obAt(mk,ts){const m=EXT.ob.get(mk);if(!m)return null;const h=Math.floor(ts/HOUR)*HOUR;return m.get(h)||m.get(h-HOUR)||m.get(h-2*HOUR)||null}
function cgAt(ts){const h=Math.floor(ts/HOUR)*HOUR;return EXT.cg.get(h)||EXT.cg.get(h-HOUR)||EXT.cg.get(h-2*HOUR)||null}
function prep(cand,mk=''){
  const ts=cand.map(x=>+x[0]),o=cand.map(x=>+x[1]),h=cand.map(x=>+x[2]),l=cand.map(x=>+x[3]),c=cand.map(x=>+x[4]),v=cand.map(x=>+x[5]);
  const e12=ema(c,12),e26=ema(c,26),mm=c.map((_,i)=>e12[i]-e26[i]),ms=ema(mm,9),mh=mm.map((x,i)=>x-ms[i]);
  const B=boll(c),bw=B.map((b,i)=>b?(b.u-b.l)/b.m:null),vr=v.map((x,i)=>{if(i<20)return 1;let s=0;for(let k=i-20;k<i;k++)s+=v[k];return x/((s/20)||1e-9)});
  const D=DAY[TF],pv=[0],pp=[0];for(let i=0;i<c.length;i++){pv.push(pv[i]+v[i]);pp.push(pp[i]+v[i]*(h[i]+l[i]+c[i])/3)}
  const vw=c.map((_,i)=>{const a=Math.max(0,i-D+1),sv=pv[i+1]-pv[a];return sv>0?(pp[i+1]-pp[a])/sv:c[i]});          // VWAP der letzten 24h
  const rv=c.map((_,i)=>{if(i<8*D)return 1;const v24=pv[i+1]-pv[i+1-D],v7=(pv[i+1-D]-pv[i+1-8*D])/7;return v24/(v7||1e-9)}); // 24h-Volumen ggü. Schnitt der 7 Tage davor
  const AX=adx(h,l,c);
  return{mk,ts,o,h,l,c,v,e20:ema(c,20),e50:ema(c,50),e200:ema(c,200),R:rsi(c),mh,B,bw,A:atr(h,l,c),vr,vw,rv,adx:AX.X,pdi:AX.P,mdi:AX.M,hi24:priorMax(h,D),hi7:priorMax(h,7*D)};
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
 {g:'v2',n:'Abstand zum 24h-VWAP',num:1,f:(d,i)=>clip((d.c[i]-d.vw[i])/(d.A[i]||1e-9)/3,-1,1),t:v=>'Kurs '+Math.abs(v*3).toFixed(1)+' ATR '+(v>0?'über':'unter')+' dem 24h-VWAP'},
 {g:'v2',n:'Trendstärke (ADX)',num:1,f:(d,i)=>clip(d.adx[i]/50,0,1.5),t:v=>'ADX '+(v*50).toFixed(0)+': '+(v*50>=25?'kräftiger Trend':'kaum Trend')},
 {g:'v2',n:'ADX-Richtung',f:(d,i)=>d.adx[i]>=25?(d.pdi[i]>d.mdi[i]?1:-1):0,t:v=>v>0?'Starker Trend nach oben (ADX ≥ 25, +DI vorne)':'Starker Trend nach unten (ADX ≥ 25, −DI vorne)'},
 {g:'v2',n:'Relatives Volumen 24h/7T',num:1,f:(d,i)=>clip(Math.log2(d.rv[i]||1),-2,3),t:v=>'Volumen 24h '+(2**v).toFixed(1)+'× der Vorwoche'},
 {g:'v2',n:'Abstand zum 24h-Hoch',num:1,f:(d,i)=>d.hi24[i]==null?0:clip((d.c[i]-d.hi24[i])/(d.A[i]||1e-9)/3,-1,1),t:v=>v>=0?'Über dem 24h-Hoch':'Kurs '+Math.abs(v*3).toFixed(1)+' ATR unter dem 24h-Hoch'},
 {g:'v2',n:'Ausbruch über 7-Tage-Hoch',f:(d,i)=>d.hi7[i]!=null&&d.c[i]>d.hi7[i]?1:0,t:()=>'Ausbruch über das 7-Tage-Hoch'},
 {g:'v2',n:'Bitcoin 24h',num:1,f:(d,i)=>clip(((BTCX.get(d.ts[i])||[0])[0])*10,-1.5,1.5),t:v=>'Bitcoin 24h '+pct(v*10)},
 {g:'v2',n:'Bitcoin-Trend',f:(d,i)=>(BTCX.get(d.ts[i])||[0,0])[1],t:v=>v>0?'Bitcoin über EMA 50 (Rückenwind)':'Bitcoin unter EMA 50 (Gegenwind)'},
 {g:'v2',n:'Session Europa (7–13 UTC)',f:(d,i)=>{const h=new Date(d.ts[i]).getUTCHours();return h>=7&&h<13?1:0},t:()=>'Europa-Session'},
 {g:'v2',n:'Session USA (13–21 UTC)',f:(d,i)=>{const h=new Date(d.ts[i]).getUTCHours();return h>=13&&h<21?1:0},t:()=>'US-Session'},
 {g:'v2',n:'Session spät (21–24 UTC)',f:(d,i)=>new Date(d.ts[i]).getUTCHours()>=21?1:0,t:()=>'Späte Session'},
 {g:'v2',n:'RSI tief im Aufwärtstrend',f:(d,i)=>d.R[i]<40&&d.c[i]>d.e50[i]&&d.e20[i]>d.e50[i]?1:0,t:(v,d,i)=>'Rücksetzer im Aufwärtstrend (RSI '+d.R[i].toFixed(0)+')'},
 {g:'v2',n:'Ausbruch mit Volumen',f:(d,i)=>d.hi24[i]!=null&&d.c[i]>d.hi24[i]&&d.vr[i]>1.5?1:0,t:(v,d,i)=>'Ausbruch über das 24h-Hoch mit '+d.vr[i].toFixed(1)+'× Volumen'},
 {g:'v2',n:'Coin und Bitcoin im Aufwärtstrend',f:(d,i)=>d.c[i]>d.e50[i]&&d.e20[i]>d.e50[i]&&(BTCX.get(d.ts[i])||[0,0])[1]>0?1:0,t:()=>'Coin und Bitcoin beide im Aufwärtstrend'},

 // Stimmung (Fear & Greed, rückwirkend verfügbar)
 {g:'fg',n:'Fear & Greed',num:1,f:(d,i)=>{const v=fgAt(d.ts[i]);return v==null?NaN:(v-50)/25},t:v=>'Fear & Greed '+Math.round(v*25+50)},
 {g:'fg',n:'Fear & Greed 7 Tage',num:1,f:(d,i)=>{const a=fgAt(d.ts[i]),b=fgAt(d.ts[i]-7*DAYMS);return a==null||b==null?NaN:clip((a-b)/20,-2,2)},t:v=>'Fear & Greed '+(v>0?'+':'')+Math.round(v*20)+' Punkte in 7 Tagen'},
 {g:'fg',n:'Extreme Angst (F&G < 25)',f:(d,i)=>{const v=fgAt(d.ts[i]);return v==null?NaN:v<25?1:0},t:()=>'Extreme Angst am Markt'},
 // Orderbuch (wird vom Bot gesammelt)
 {g:'ob',n:'Spread',num:1,f:(d,i)=>{const o=obAt(d.mk,d.ts[i]);return o?clip(Math.log10(o.spread+0.01)+1,-1,3):NaN},t:v=>'Spread '+(10**(v-1)-0.01).toFixed(2)+' %'},
 {g:'ob',n:'Markttiefe ±2 %',num:1,f:(d,i)=>{const o=obAt(d.mk,d.ts[i]);return o?clip(Math.log10(o.b2+o.a2+1)-4,-3,3):NaN},t:v=>'Markttiefe ±2 %: '+fmtV(10**(v+4))+' €'},
 {g:'ob',n:'Orderbuch-Ungleichgewicht',num:1,f:(d,i)=>{const o=obAt(d.mk,d.ts[i]);return o?o.imb:NaN},t:v=>v>0?'Mehr Kauf- als Verkaufsaufträge nahe am Kurs':'Mehr Verkaufs- als Kaufaufträge nahe am Kurs'},
 // CoinGecko-Marktdaten (werden vom Bot gesammelt)
 {g:'cg',n:'Gesamtmarkt 24h',num:1,f:(d,i)=>{const c=cgAt(d.ts[i]);return c&&c.chg!=null?clip(c.chg/5,-2,2):NaN},t:v=>'Krypto-Gesamtmarkt 24h '+pct(v*5)},
 {g:'cg',n:'BTC-Dominanz 24h',num:1,f:(d,i)=>{const a=cgAt(d.ts[i]),b=cgAt(d.ts[i]-DAYMS);return a&&b&&a.dom!=null&&b.dom!=null?clip(a.dom-b.dom,-2,2):NaN},t:v=>'BTC-Dominanz '+(v>0?'+':'')+v.toFixed(2)+' Prozentpunkte in 24h'},
 {g:'cg',n:'Trending auf CoinGecko',f:(d,i)=>{const c=cgAt(d.ts[i]);return c&&c.tr?(c.tr.has(d.mk.split('-')[0])?1:0):NaN},t:()=>'Trending auf CoinGecko'},
];
// Welche Merkmalgruppen aktiv sind, entscheidet der wöchentliche Vergleich des Bots ('v1' = Basis, '+v2', '+fg', '+ob', '+cg')
const GROUP_NAMES={v2:'erweitert',fg:'Fear & Greed',ob:'Orderbuch',cg:'CoinGecko'};
let FEATSET='v1',GROUPS=new Set(),ACTIVE=FEATS.filter(F=>!F.g),K=ACTIVE.length;
function setFeatSet(s){GROUPS=new Set(String(s||'v1').split('+').filter(x=>GROUP_NAMES[x]));
  FEATSET=['v1',...Object.keys(GROUP_NAMES).filter(x=>GROUPS.has(x))].join('+').replace(/^v1\+v2/,'v2');
  ACTIVE=FEATS.filter(F=>!F.g||GROUPS.has(F.g));K=ACTIVE.length}
const featLabel=()=>['Basis',...Object.keys(GROUP_NAMES).filter(x=>GROUPS.has(x)).map(x=>GROUP_NAMES[x])].join(' + ');
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
  // Fehlende Werte (NaN, z. B. vor Beginn der Datensammlung) zählen als neutral
  const mu=new Float64Array(K),sd=new Float64Array(K),cn=new Float64Array(K);
  for(let i=0;i<n;i++)for(let k=0;k<K;k++){const v=X[i*K+k];if(v===v){mu[k]+=v;cn[k]++}}for(let k=0;k<K;k++)mu[k]=cn[k]?mu[k]/cn[k]:0;
  for(let i=0;i<n;i++)for(let k=0;k<K;k++){const v=X[i*K+k];if(v===v)sd[k]+=(v-mu[k])**2}for(let k=0;k<K;k++)sd[k]=cn[k]?Math.sqrt(sd[k]/cn[k])||1:1;
  const Z=new Float64Array(n*K);for(let i=0;i<n;i++)for(let k=0;k<K;k++){const v=X[i*K+k];Z[i*K+k]=v===v?(v-mu[k])/sd[k]:0}
  let base=0;for(let i=0;i<n;i++)base+=y[i];base=clip(base/n,.01,.99);
  const w=new Float64Array(K),g=new Float64Array(K);let b=Math.log(base/(1-base));const lr=.8,lam=2e-3;
  for(let it=0;it<iters;it++){g.fill(0);let gb=0;
    for(let i=0;i<n;i++){let s=b;for(let k=0;k<K;k++)s+=w[k]*Z[i*K+k];const e=1/(1+Math.exp(-s))-y[i];gb+=e;for(let k=0;k<K;k++)g[k]+=e*Z[i*K+k]}
    b-=lr*gb/n;for(let k=0;k<K;k++)w[k]-=lr*(g[k]/n+lam*w[k]);}
  return{w:Array.from(w),b,mu:Array.from(mu),sd:Array.from(sd),base};
}
function predict(m,x){let s=m.b;for(let k=0;k<m.w.length;k++){const v=x[k];if(v===v)s+=m.w[k]*(v-m.mu[k])/m.sd[k]}return 1/(1+Math.exp(-s))}
function contrib(m,x){return x.map((v,k)=>v===v?m.w[k]*(v-m.mu[k])/m.sd[k]:0)}

// src: Kursverlauf je Markt; stride: nur jede n-te Kerze verwenden (bei sehr langem Verlauf)
async function trainModel(src=data,stride=1,minTs=0,maxTs=Infinity,outFn=outcome){
  setStat('Lerne aus der Vergangenheit: sammle Beispiele…','');await tick();
  const S=[];const H=horBars();
  for(const mk of Object.keys(src)){const d=src[mk];for(let i=210;i<d.c.length-H;i+=stride){if(!d.A[i]||d.ts[i]<minTs||d.ts[i]>=maxTs)continue;const o=outFn(d,i);S.push({mk,ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r})}}
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
  ACTIVE.forEach((F,k)=>{if(x[k]!==x[k])return;const active=F.num?Math.abs(ct[k])>.04:x[k]!==0;if(active)reasons.push([ct[k],F.t(x[k],d,N)])});
  reasons.sort((a,b)=>Math.abs(b[0])-Math.abs(a[0]));
  const lb=SRBARS[TF],sup=Math.min(...d.l.slice(-lb)),res=Math.max(...d.h.slice(-lb)),a=d.A[N];
  const R=riskOf(last,a),stop=last-R,t1=last+GEO.tp*R,t2=Math.max(res,last+(GEO.tp+1)*R);
  const sig=ev>=.25?[2,'Starker Kauf']:ev>=.08?[1,'Kauf']:ev>-.08?[0,'Neutral']:ev>-.25?[-1,'Meiden']:[-2,'Stark meiden'];
  return{p,cal,ev,score:Math.round(clip(ev*100,-100,100)),sig,reasons,rsi:d.R[N],atrPct:a/last*100,volR:d.vr[N],sup,res,stop,t1,t2,
    trend:last>d.e50[N]?(d.e20[N]>d.e50[N]?'aufwärts':'erholt'):(d.e20[N]<d.e50[N]?'abwärts':'schwach'),d};
}


let TF=process.env.TF||'1h', markets=[], data={}, results={}, model=null, lastTrain=0, BOOK={};
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
      if(r.status===429){if(url.startsWith(API))bvNext=Math.max(bvNext,Date.now()+20e3);else await sleep(5e3);continue}
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
      if(buy>0){const ex=st.pos[mk];
        if(ex&&ex.qty&&qty){const q=ex.qty+qty;st.pos[mk]={buy:(ex.buy*ex.qty+buy*qty)/q,qty:q,cost:(ex.cost??ex.buy*ex.qty*(1+FEE))+buy*qty*(1+FEE),t:ex.t};const n=st.pos[mk];confirmations.push({kind:'add',mk,nach:qty,preis:buy,snap:{buy:n.buy,qty:n.qty,cost:n.cost}})}   // Nachkauf: Durchschnittspreis
        else{st.pos[mk]={buy,qty,cost:qty?buy*qty*(1+FEE):null,t:m.time*1000};confirmations.push({kind:'add',mk,snap:{buy,qty,cost:st.pos[mk].cost}})}
        delete st.notified['s:'+mk]}
    }else if(x=t.match(/^(verkauf|verkaufen|verkauft|sell)\s+([a-z0-9]+)(?:-eur)?(?:\s+([\d'.,]+)(?:\s+([\d'.,]+))?)?/i)){
      const mk=x[2].toUpperCase()+'-EUR',p=st.pos[mk];
      if(p){const sell=x[3]?num(x[3]):null,qq=x[4]?num(x[4]):null,part=!!(qq&&p.qty&&qq<p.qty*0.9999);
        const cost=p.qty?(p.cost??p.buy*p.qty*(1+FEE)):null,qs=part?qq:p.qty,cs=cost&&qs?cost*qs/p.qty:null,net=sell&&qs?qs*sell*(1-FEE):null,eur=cs!=null&&net!=null?net-cs:null;
        st.closed.push({m:mk,buy:p.buy,sell,qty:qs,t:p.t,end:m.time*1000,eur,teil:part});st.closed=st.closed.slice(-200);
        if(part){p.qty-=qq;p.cost=cost-cs;confirmations.push({kind:'part',mk,q:qq,rest:p.qty,sell,eur,net})}
        else{delete st.pos[mk];delete st.notified['s:'+mk];confirmations.push({kind:'del',mk,sell,buy:p.buy,eur,net})}}
      else confirmations.push({kind:'unknown',mk});
    }else if(/^(liste|status|positionen)$/i.test(t))confirmations.push({kind:'list'});
    else confirmations.push({kind:'help',t});
  }
}

function advice(mk,p,last){
  const r=results[mk],a=r?r.d.A[r.d.c.length-1]:last*0.02;
  // Ergebnis nach Gebühren für Kauf und Verkauf
  const cost=p.qty?(p.cost??p.buy*p.qty*(1+FEE)):null,eur=p.qty?p.qty*last*(1-FEE)-cost:null,pnl=cost?eur/cost*100:((last*(1-FEE))/(p.buy*(1+FEE))-1)*100;
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
  orderbuch:[{res:0,dir:'orderbuch/lauf',days:30},{res:60,dir:'orderbuch/1h',days:365},{res:1440,dir:'orderbuch/24h',days:1095}],
  stimmung:[{res:0,dir:'stimmung/lauf',days:30},{res:60,dir:'stimmung/1h',days:365},{res:1440,dir:'stimmung/24h',days:1095}],
};
const iso=ts=>new Date(ts).toISOString().slice(0,16).replace('T',' ');
const dayOf=ts=>new Date(ts).toISOString().slice(0,10);
const csvq=v=>{v=v==null?'':String(v);return /[",\n;]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
function appendCsv(rel,header,rows){
  if(!rows.length)return;const f=LOG+'/'+rel;fs.mkdirSync(path.dirname(f),{recursive:true});
  if(!fs.existsSync(f))fs.writeFileSync(f,header.join(',')+'\n');
  fs.appendFileSync(f,rows.map(r=>r.map(csvq).join(',')).join('\n')+'\n');
}
// Zeilen in eine gepackte Datei einfügen, ohne Vorhandenes zu verlieren (gleiche Zeit + gleicher Markt nur einmal)
function mergeGz(f,header,lines){
  let old=[];if(fs.existsSync(f)){const t=zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').trim().split('\n');header=t[0]||header;old=t.slice(1)}
  const m=new Map();for(const l of [...old,...lines]){if(!l)continue;const c=l.split(',');m.set(c[0]+'|'+c[1],l)}
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,zlib.gzipSync([header,...[...m.values()].sort()].join('\n')+'\n',{level:9}));
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
  let n=0;for(const f of Object.keys(byFile).sort()){byFile[f].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);n+=byFile[f].length;
    const gz=LOG+'/'+f+'.gz';if(fs.existsSync(gz))mergeGz(gz,HK.join(','),byFile[f].map(r=>r.map(csvq).join(',')));else appendCsv(f,HK,byFile[f])}
  console.log(`${n} neue 1-Minuten-Werte geloggt.`);
}
// Einmalig: 1-Minuten-Werte seit Beginn des Logbuchs bei Bitvavo nachladen und einfügen (behebt verlorene Stunden)
const REPAIR_V=1;
async function repair1m(){
  if(st.repair1m===REPAIR_V)return;
  const from=Date.UTC(2026,10,3,19,0),to=Math.floor(Date.now()/36e5)*36e5-1,W=1440*6e4,byFile={};let n=0;
  await pool(markets.filter(eligible),5,async m=>{
    for(let s=from;s<to;s+=W){const e=Math.min(to,s+W-1);
      const rows=await j(`${API}/${m.market}/candles?interval=1m&limit=1440&start=${s}&end=${e}`);
      for(const k of rows||[]){const ts=+k[0];if(ts<from||ts>to)continue;const f=hourFile(TIERS.kurse[0].dir,ts);(byFile[f]||(byFile[f]=[])).push([iso(ts),m.market,k[1],k[2],k[3],k[4],k[5]].join(','));n++}}
  });
  for(const f of Object.keys(byFile)){const gz=LOG+'/'+f+'.gz',csv=LOG+'/'+f;
    if(fs.existsSync(csv)){const x=readCsv(csv);mergeGz(gz,HK.join(','),[...x.rows,...byFile[f]]);fs.unlinkSync(csv)}else mergeGz(gz,HK.join(','),byFile[f])}
  st.repair1m=REPAIR_V;console.log(`Reparatur: ${n} 1-Minuten-Werte seit 03.11. 19:00 UTC nachgeladen und eingefügt.`);
}
/* ---------- Zusätzliche Daten erfassen, die man später nicht mehr abrufen kann ---------- */
const HO=['zeit_utc','markt','bid','ask','spread_pct','tiefe_1pct_kauf_eur','tiefe_1pct_verkauf_eur','tiefe_2pct_kauf_eur','tiefe_2pct_verkauf_eur','ungleichgewicht_1pct'];
const HST=['zeit_utc','markt','fear_greed','fear_greed_text','marktkap_eur','marktkap_24h_pct','btc_dominanz','eth_dominanz','trending'];
const hourKey=t=>Math.floor(t/HOUR)*HOUR;
async function logExt(){
  const now=Date.now(),t=iso(now),h=hourKey(now),live={zeit:new Date(now).toISOString(),stunde:h,orderbuch:{},stimmung:null,trending:[]};
  // Stimmung: Fear & Greed (mit Verlauf der letzten 60 Tage), CoinGecko global und Trending
  let fg=null,fgTxt='',g=null,tr=null;
  try{const f=await j('https://api.alternative.me/fng/?limit=60',2);for(const x of f.data)EXT.fg.set(Math.floor(+x.timestamp*1000/DAYMS)*DAYMS,+x.value);fg=+f.data[0].value;fgTxt=f.data[0].value_classification}catch(e){console.warn('Fear & Greed:',e.message)}
  try{g=(await j(CG+'/global',2)).data}catch(e){console.warn('CoinGecko global:',e.message)}
  try{tr=(await j(CG+'/search/trending',2)).coins.map(c=>String(c.item.symbol).toUpperCase())}catch(e){console.warn('CoinGecko Trending:',e.message)}
  const chg=g?.market_cap_change_percentage_24h_usd,dom=g?.market_cap_percentage?.btc;
  if(g||tr||fg!=null){
    appendCsv(hourFile(TIERS.stimmung[0].dir,now),HST,[[t,'GESAMT',fg??'',fgTxt,g?Math.round(g.total_market_cap?.eur||0):'',chg!=null?chg.toFixed(3):'',dom!=null?dom.toFixed(3):'',g?.market_cap_percentage?.eth!=null?g.market_cap_percentage.eth.toFixed(3):'',(tr||[]).join(' ')]]);
    loadExtLog(['stimmung'],now-26*HOUR);                                   // für die 24h-Änderung der Dominanz
    EXT.cg.set(h,{chg:chg??null,dom:dom??null,tr:tr?new Set(tr):null});
    const d24=cgAt(now-DAYMS);live.stimmung={fng:fg,chg:chg??null,dom:dom??null,dom24:d24?.dom??null};live.trending=tr||[];
  }
  // Orderbuch je Markt: Spread, Markttiefe ±1 % und ±2 %, Ungleichgewicht
  const rows=[];
  await pool(markets.filter(eligible),5,async m=>{
    const b=await j(`${API}/${m.market}/book?depth=200`);
    const bids=(b.bids||[]).map(x=>[+x[0],+x[1]]),asks=(b.asks||[]).map(x=>[+x[0],+x[1]]);if(!bids.length||!asks.length)return;
    const bid=bids[0][0],ask=asks[0][0],mid=(bid+ask)/2,dep=(arr,lo,hi)=>arr.reduce((s,[p,a])=>p>=lo&&p<=hi?s+p*a:s,0);
    const b1=dep(bids,mid*.99,Infinity),a1=dep(asks,0,mid*1.01),b2=dep(bids,mid*.98,Infinity),a2=dep(asks,0,mid*1.02);
    const o={spread:(ask-bid)/mid*100,b1,a1,b2,a2,imb:b1+a1>0?(b1-a1)/(b1+a1):0};
    EXT.ob.set(m.market,new Map([[h,o]]));BOOK[m.market]={bid,ask};live.orderbuch[m.market]={spread:+o.spread.toFixed(4),b2:Math.round(b2),a2:Math.round(a2),imb:+o.imb.toFixed(3)};
    rows.push([t,m.market,bid,ask,o.spread.toFixed(4),Math.round(b1),Math.round(a1),Math.round(b2),Math.round(a2),o.imb.toFixed(3)]);
  });
  rows.sort((a,b)=>a[1]<b[1]?-1:1);appendCsv(hourFile(TIERS.orderbuch[0].dir,now),HO,rows);
  fs.mkdirSync(LOG+'/analyse',{recursive:true});fs.writeFileSync(LOG+'/analyse/live.json',JSON.stringify(live));
  console.log(`Zusatzdaten: Orderbuch ${rows.length} Märkte, Fear & Greed ${fg??'–'}, CoinGecko ${g?'ok':'–'}/${tr?'ok':'–'}`);
}
// Gesammelte Orderbuch- und Stimmungsdaten aus dem Logbuch einlesen (ein Wert je Stunde; ältere Tageswerte gelten für den ganzen Tag)
function loadExtLog(kinds=['orderbuch','stimmung'],since=0){
  for(const kind of kinds)for(const tier of TIERS[kind])for(const f of files(`${LOG}/${tier.dir}`)){
    const day=(path.basename(f).match(/^(\d{4}-\d{2}-\d{2})/)||[])[1];if(!day||Date.parse(day+'T00:00:00Z')+2*DAYMS<since)continue;
    const {rows}=readCsv(f);
    for(const l of rows){const c=l.split(',');const t0=Date.parse(c[0].replace(' ','T')+':00Z');if(!(t0>=since))continue;
      const hs=tier.res>=1440?Array.from({length:24},(_,k)=>hourKey(t0)+k*HOUR):[hourKey(t0)];
      if(kind==='orderbuch'){let m=EXT.ob.get(c[1]);if(!m)EXT.ob.set(c[1],m=new Map());const o={spread:+c[4],b1:+c[5],a1:+c[6],b2:+c[7],a2:+c[8],imb:+c[9]};for(const x of hs)if(!m.has(x))m.set(x,o)}
      else{const o={chg:c[5]===''?null:+c[5],dom:c[6]===''?null:+c[6],tr:c.length>8&&c[8]!==''?new Set(c[8].split(' ')):null};for(const x of hs)if(!EXT.cg.has(x))EXT.cg.set(x,o)}}
  }
}
// Fear & Greed seit 2018 (für Training und Vergleich)
async function loadFgHistory(){try{const f=await j('https://api.alternative.me/fng/?limit=0',3);for(const x of f.data)EXT.fg.set(Math.floor(+x.timestamp*1000/DAYMS)*DAYMS,+x.value);console.log(`Fear & Greed: ${f.data.length} Tage Verlauf`)}catch(e){console.warn('Fear-&-Greed-Verlauf:',e.message)}}

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
    if(kind!=='kurse'){if(!x)out.set(k,[bucket(c[0],res),...c.slice(1)]);continue}
    if(!x)out.set(k,[bucket(c[0],res),c[1],+c[2],+c[3],+c[4],+c[5],+c[6]]);
    else{x[3]=Math.max(x[3],+c[3]);x[4]=Math.min(x[4],+c[4]);x[5]=+c[5];x[6]+=+c[6]}}
  return [...out.values()].map(x=>kind!=='kurse'?x.join(','):[x[0],x[1],...x.slice(2).map(nfmt)].join(','));
}
function writeDay(dir,day,h,rows){
  const f=`${LOG}/${dir}/${day.slice(0,4)}/${day}.csv.gz`;fs.mkdirSync(path.dirname(f),{recursive:true});
  if(fs.existsSync(f)){const old=readCsv(f);rows=[...old.rows,...rows]}
  fs.writeFileSync(f,zlib.gzipSync([h,...rows].join('\n')+'\n',{level:9}));
}
function housekeeping(){
  const now=Date.now(),curHour=hourFile('',now).slice(-17,-4);let packed=0,thinned=0,deleted=0;
  // Abgeschlossene Stundendateien packen
  for(const p of files(LOG)){const m=path.basename(p).match(/^(\d{4}-\d{2}-\d{2}-\d{2})\.csv$/);if(m&&m[1]<curHour){const x=readCsv(p);mergeGz(p+'.gz',x.h,x.rows);fs.unlinkSync(p);packed++}}
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
  for(const p of [...files(`${LOG}/laeufe`),...files(`${LOG}/meldungen`),...files(`${LOG}/papier`)]){const m=path.basename(p).match(/^(\d{4}-\d{2})\.csv/);if(m&&m[1]<cutMon){fs.unlinkSync(p);deleted++}}
  const prune=d=>{if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory()&&e.name!=='.git'){prune(d+'/'+e.name);if(!fs.readdirSync(d+'/'+e.name).length)fs.rmdirSync(d+'/'+e.name)}};prune(LOG);
  if(packed||thinned||deleted)console.log(`Aufgeräumt: ${packed} Stunden gepackt, ${thinned} Tage verdichtet, ${deleted} gelöscht.`);
}

/* ---------- Langzeitverlauf: bis 24 Monate Kerzen je Markt, zwischengespeichert im Runner ---------- */
// Geladen werden 24 Monate; trainiert wird auf 12 oder 24 Monaten, je nach wöchentlichem Vergleich (st.histDays)
const HIST_MAX=+(process.env.HIST_MAX||730), CACHE=process.env.CACHE_DIR||'verlauf', LONG_V=1;
const winDays=()=>Math.min(HIST_MAX,st.histDays||365);
// Lädt [start,end] in Fenstern zu höchstens 1440 Kerzen (unabhängig von der Sortierung der Antwort)
async function fetchRange(mk,start,end,map){
  const step=TFH[TF]*36e5,W=1440*step;let n=0;
  for(let s=Math.floor(start);s<end;s+=W){const e=Math.min(Math.floor(end),s+W-1);
    const rows=await j(`${API}/${mk}/candles?interval=${TF}&limit=1440&start=${s}&end=${e}`);
    if(Array.isArray(rows))for(const r of rows){const t=+r[0];if(t>=start&&t<=end){map.set(t,[t,+r[1],+r[2],+r[3],+r[4],+r[5]]);n++}}}
  return n;
}
async function history(mk,days=HIST_MAX){
  const now=Date.now(),from=now-days*DAY_MS,f=`${CACHE}/${TF}/${mk}.json.gz`;
  let c={full:false,days:0,rows:[]};try{c=JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'))}catch(e){}
  if(c.full&&!c.days)c.days=365;                                           // Zwischenspeicher der Vorversion
  const map=new Map();for(const r of c.rows)if(r[0]>=from)map.set(r[0],r);
  if(!c.full||!map.size)await fetchRange(mk,from,now,map);                 // erstmals: ganzer Zeitraum
  else{let lo=Infinity,hi=0;for(const t of map.keys()){if(t<lo)lo=t;if(t>hi)hi=t}
    if(c.days<days)await fetchRange(mk,from,lo-1,map);                     // Zeitraum verlängert: Älteres ergänzen
    await fetchRange(mk,hi,now,map)}                                       // danach: nur Neues
  const rows=[...map.values()].sort((a,b)=>a[0]-b[0]);
  fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,zlib.gzipSync(JSON.stringify({full:true,days,rows})));
  return rows;
}
function packModel(m){
  const q=m.allP,N=Math.min(1000,q.length),allP=Array.from({length:N},(_,i)=>+q[Math.round(i*(q.length-1)/Math.max(1,N-1))].toFixed(6));
  return{w:m.w,b:m.b,mu:m.mu,sd:m.sd,base:m.base,buckets:m.buckets,allP,baseWin:m.baseWin,baseR:m.baseR,coin:m.coin,n:m.n,ntest:m.ntest,
    from:new Date(m.from).toISOString(),to:new Date(m.to).toISOString(),tf:m.tf,trained:m.trained,top:m.top,top2:m.top2,merkmale:FEATSET,tage:winDays()};
}
// Einmal täglich: 24 Monate laden, wöchentliche Analysen, Modell trainieren und veröffentlichen
async function longTrain(){
  const t0=Date.now(),c0=bvCount;st.longTryAt=t0;
  const list=markets.filter(eligible).map(m=>m.market);if(!list.includes('BTC-EUR'))list.push('BTC-EUR');
  const hist={};let bars=0;
  await pool(list,3,async mk=>{const rows=await history(mk);if(rows.length>=300){hist[mk]=prep(rows,mk);bars+=rows.length}});
  const mk=Object.keys(hist).length;
  console.log(`Langzeitverlauf: ${mk} Märkte, ${bars.toLocaleString('de-CH')} Kerzen (bis ${HIST_MAX} Tage), ${bvCount-c0} Abfragen, ${((Date.now()-t0)/1e3).toFixed(0)} s.`);
  if(!hist['BTC-EUR']||mk<10)throw new Error('Langzeitverlauf unvollständig');
  setBtc(hist);await loadFgHistory();loadExtLog();
  if(!st.winAt||Date.now()-st.winAt>7*DAY_MS)await windowAB(hist);
  const minTs=Date.now()-winDays()*DAY_MS;let inWin=0;for(const d of Object.values(hist))for(const t of d.ts)if(t>=minTs)inWin++;
  if(!st.geoAt||Date.now()-st.geoAt>7*DAY_MS)await geoAnalysis(hist,minTs);
  if(!st.featAt||Date.now()-st.featAt>7*DAY_MS)await featureAB(hist,minTs);
  setFeatSet(st.featSet||'v1');
  const t1=Date.now();
  await trainModel(hist,Math.max(1,Math.round(inWin/450000)),minTs);
  st.model=packModel(model);st.modelAt=Date.now();st.longTryAt=0;   // Sperre nur nach Fehlschlägen
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  fs.writeFileSync(LOG+'/analyse/modell.json',JSON.stringify({...st.model,merkmal_namen:ACTIVE.map(F=>F.n),gebuehr_pro_seite:FEE}));
  console.log(`Langzeitmodell (${winDays()} Tage): ${model.n.toLocaleString('de-CH')} Signale, ${model.from.toISOString().slice(0,10)} bis ${model.to.toISOString().slice(0,10)}, Basis ${(model.baseWin*100).toFixed(0)} %, Top-10 % ${(model.top.win*100).toFixed(0)} % / ${fmtR(model.top.r)} (${((Date.now()-t1)/1e3).toFixed(0)} s)`);
  setBtc();
}

/* ---------- 12 gegen 24 Monate Lerndaten: wöchentlicher Vergleich auf denselben 3 Testmonaten ---------- */
async function windowAB(src){
  const t0=Date.now(),now=t0,testFrom=now-91*DAY_MS,hb=horBars(),gap=hb*TFH[TF]*36e5,D=Object.values(src);
  const stride=Math.max(1,Math.round(D.reduce((s,d)=>s+d.c.length,0)/500000)),S=[];let oldest=Infinity;
  for(const d of D)for(let i=210;i<d.c.length-hb;i+=stride)if(d.A[i]){const o=outcome(d,i);S.push({ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r});if(d.ts[i]<oldest)oldest=d.ts[i]}
  const test=S.filter(s=>s.ts>=testFrom);if(test.length<2000)return console.log('Zu wenig Daten für den Lernfenster-Vergleich.');
  const res={};
  for(const W of [365,730]){
    // Trainiert wird nur auf Daten vor dem Testzeitraum (mit Abstand, damit kein Ergebnis in den Test hineinreicht)
    const tr=S.filter(s=>s.ts<testFrom-gap&&s.ts>=now-W*DAY_MS),n=tr.length;if(n<2000){res[W]=null;continue}
    const X=new Float64Array(n*K),Y=new Float64Array(n);tr.forEach((s,i)=>{for(let k=0;k<K;k++)X[i*K+k]=s.x[k];Y[i]=s.y});
    const m=fit(X,Y,n,120),t=test.map(s=>[predict(m,s.x),s.r,s.y]).sort((a,b)=>b[0]-a[0]);
    const top=f=>{const q=t.slice(0,Math.max(1,Math.floor(t.length*f)));return{r:q.reduce((s,x)=>s+x[1],0)/q.length,w:q.reduce((s,x)=>s+x[2],0)/q.length}};
    const a=top(.1),b=top(.2);res[W]={n,top10_r:a.r,top10_win:a.w,top20_r:b.r,score:(a.r+b.r)/2};
  }
  const win=res[730]&&res[365]&&res[730].score>res[365].score+0.01?730:365;st.histDays=win;st.winAt=now;
  const days=Math.round((testFrom-oldest)/DAY_MS),d=iso(now);
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  const f=LOG+'/analyse/lernfenster.csv',head='datum_utc,lerndaten_monate,trainings_beispiele,erwartung_top10_r,trefferquote_top10,erwartung_top20_r,gewaehlt';
  const old=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').slice(1):[];
  const line=W=>{const x=res[W];return x?[d,W/365*12,x.n,x.top10_r.toFixed(3),x.top10_win.toFixed(3),x.top20_r.toFixed(3),win===W?'ja':'nein'].join(','):[d,W/365*12,0,'','','','nein'].join(',')};
  fs.writeFileSync(f,[head,...old,line(365),line(730)].join('\n')+'\n');
  const af=LOG+'/analyse/aktuell.json';let ak={};try{ak=JSON.parse(fs.readFileSync(af,'utf8'))}catch(e){}
  fs.writeFileSync(af,JSON.stringify({...ak,lernfenster_monate:win/365*12,lernfenster_vergleich:{m12:res[365]&&+res[365].score.toFixed(3),m24:res[730]&&+res[730].score.toFixed(3),test_monate:3,verfuegbare_tage_vor_test:days,gemessen:new Date(now).toISOString()}},null,1));
  console.log(`Lernfenster-Vergleich (${((Date.now()-t0)/1e3).toFixed(0)} s, Test ${test.length} Beispiele): 12 Monate ${res[365]?fmtR(res[365].score):'–'}, 24 Monate ${res[730]?fmtR(res[730].score):'–'} → ${win/365*12} Monate`);
}

/* ---------- Welcher Trade-Aufbau lohnt sich nach Gebühren? (einmal pro Woche) ---------- */
async function geoAnalysis(src=data,minTs=0){
  const t0=Date.now(),S=[],tail=Math.round(48/TFH[TF]),D=Object.values(src);let cnt=0;for(const d of D)for(const t of d.ts)if(t>=minTs)cnt++;
  const stride=Math.max(1,Math.round(cnt/150000));
  for(const d of D)for(let i=210;i<d.c.length-tail;i+=stride)if(d.A[i]&&d.ts[i]>=minTs)S.push({d,i,ts:d.ts[i],x:feat(d,i)});
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

/* ---------- Merkmalgruppen: wöchentlich prüfen, ob sie die Vorhersage verbessern ---------- */
// Jede Gruppe wird mit und ohne getestet (übrige Auswahl gleich). Gesammelte Daten (Orderbuch, CoinGecko) erst ab 90 Tagen.
function coverageDays(g,now){
  if(g==='v2')return Infinity;let lo=Infinity;
  if(g==='fg')for(const t of EXT.fg.keys())lo=Math.min(lo,t);
  if(g==='ob')for(const m of EXT.ob.values())for(const t of m.keys())lo=Math.min(lo,t);
  if(g==='cg')for(const t of EXT.cg.keys())lo=Math.min(lo,t);
  return lo===Infinity?0:(now-lo)/DAY_MS;
}
async function featureAB(src=data,minTs=0){
  const t0=Date.now(),now=t0,hb=horBars(),gap=hb*TFH[TF]*36e5,D=Object.values(src);
  const cur=new Set(String(st.featSet||'v1').split('+').filter(x=>GROUP_NAMES[x]));
  setFeatSet('v2+fg+ob+cg');const ALL=ACTIVE.slice();
  let cnt=0;for(const d of D)for(const t of d.ts)if(t>=minTs)cnt++;
  const stride=Math.max(1,Math.round(cnt/400000)),S=[];
  for(const d of D)for(let i=210;i<d.c.length-hb;i+=stride)if(d.A[i]&&d.ts[i]>=minTs){const o=outcome(d,i);S.push({ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r})}
  if(S.length<2000){setFeatSet(st.featSet||'v1');return console.log('Zu wenig Daten für den Merkmal-Vergleich.')}
  const score=(cols,testFrom)=>{const tr=S.filter(s=>s.ts<testFrom-gap),te=S.filter(s=>s.ts>=testFrom),k=cols.length,n=tr.length;
    const X=new Float64Array(n*k),Y=new Float64Array(n);tr.forEach((s,i)=>{cols.forEach((c,j)=>X[i*k+j]=s.x[c]);Y[i]=s.y});
    const m=fit(X,Y,n,120,k),t=te.map(s=>[predict(m,cols.map(c=>s.x[c])),s.r,s.y]).sort((a,b)=>b[0]-a[0]);
    const top=f=>{const q=t.slice(0,Math.max(1,Math.floor(t.length*f)));return{r:q.reduce((s,x)=>s+x[1],0)/q.length,w:q.reduce((s,x)=>s+x[2],0)/q.length}};
    const a=top(.1),b=top(.2);return{k,top10_r:a.r,top10_win:a.w,top20_r:b.r,score:(a.r+b.r)/2}};
  const d=iso(now),lines=[],vgl={};
  for(const g of Object.keys(GROUP_NAMES)){
    const cov=coverageDays(g,now),name=GROUP_NAMES[g];
    if(cov<90){cur.delete(g);vgl[g]={wartet:`${Math.floor(cov)} von 90 Tagen gesammelt`};lines.push([d,'mit '+name,'','','','',`wartet (${Math.floor(cov)}/90 Tage)`].join(','));console.log(`Merkmale ${name}: ${Math.floor(cov)} von 90 Tagen gesammelt, Test folgt`);continue}
    const testFrom=now-(cov>=winDays()?91:30)*DAY_MS;
    const colsA=ALL.map((F,k)=>(!F.g||(cur.has(F.g)&&F.g!==g))?k:-1).filter(k=>k>=0),colsB=ALL.map((F,k)=>(!F.g||(cur.has(F.g)&&F.g!==g)||F.g===g)?k:-1).filter(k=>k>=0);
    const A=score(colsA,testFrom),B=score(colsB,testFrom),use=B.score>A.score+0.01;
    if(use)cur.add(g);else cur.delete(g);vgl[g]={ohne:+A.score.toFixed(3),mit:+B.score.toFixed(3),genutzt:use};
    lines.push([d,'ohne '+name,A.k,A.top10_r.toFixed(3),A.top10_win.toFixed(3),A.top20_r.toFixed(3),use?'nein':'ja'].join(','),[d,'mit '+name,B.k,B.top10_r.toFixed(3),B.top10_win.toFixed(3),B.top20_r.toFixed(3),use?'ja':'nein'].join(','));
    console.log(`Merkmale ${name}: ohne ${fmtR(A.score)}, mit ${fmtR(B.score)} → ${use?'nutzen':'weglassen'}`);
  }
  setFeatSet(['v1',...cur].join('+'));st.featSet=FEATSET;st.featAt=now;
  fs.mkdirSync(LOG+'/analyse',{recursive:true});
  const f=LOG+'/analyse/merkmale.csv',head='datum_utc,variante,anzahl_merkmale,erwartung_top10_r,trefferquote_top10,erwartung_top20_r,gewaehlt';
  const old=fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').slice(1):[];
  fs.writeFileSync(f,[head,...old,...lines].join('\n')+'\n');
  const af=LOG+'/analyse/aktuell.json';let ak={};try{ak=JSON.parse(fs.readFileSync(af,'utf8'))}catch(e){}
  fs.writeFileSync(af,JSON.stringify({...ak,geo:st.geo||ak.geo,merkmale:FEATSET,merkmale_vergleich:{...vgl,gemessen:new Date(now).toISOString()}},null,1));
  console.log(`Merkmal-Vergleich (${((Date.now()-t0)/1e3).toFixed(0)} s, ${S.length} Beispiele): gewählt ${featLabel()}`);
}

/* ---------- Papierhandel: so würde der Bot über die Bitvavo-API handeln (simuliert, ohne echtes Geld) ---------- */
// Zwei Varianten mit denselben Signalen: «limit» kauft mit Limit-Order zum Geldkurs (0,15 %, verfällt nach 15 Min)
// und verkauft am Ziel per Limit; «markt» kauft und verkauft sofort zum Marktpreis (0,25 %). Stop-Loss immer als Marktorder.
const PAPER={kapital:1000,betrag:100,maxPos:10,maker:0.0015,taker:0.0025,limitMin:15};
const VARIANTS={limit:'Limit-Orders',markt:'Marktorders'};
const HP=['variante','markt','kauf_utc','kaufpreis','menge','verkauf_utc','verkaufspreis','grund','gebuehren_eur','ergebnis_eur','ergebnis_pct'];
async function paperStep(){
  const now=Date.now();
  if(!st.paper)st.paper={start:now,prevOn:{},lastCheck:now-5*6e4,curve:[]};
  const P=st.paper;for(const k of Object.keys(VARIANTS))if(!P[k])P[k]={cash:PAPER.kapital,pos:{},orders:{},fees:0,closed:0,wins:0,pnl:0,storniert:0};
  // 1-Minuten-Kerzen seit der letzten Prüfung für alle offenen Positionen und Orders
  const need=new Set();for(const k of Object.keys(VARIANTS)){Object.keys(P[k].pos).forEach(m=>need.add(m));Object.keys(P[k].orders).forEach(m=>need.add(m))}
  const bars={},from=Math.max(P.lastCheck-6e4,now-6*36e5);
  await pool([...need],5,async mk=>{const r=await j(`${API}/${mk}/candles?interval=1m&limit=1440&start=${from}&end=${now}`);bars[mk]=(r||[]).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4]})).filter(b=>b.t+6e4<=now).sort((a,b)=>a.t-b.t)});
  const lastPx=mk=>BOOK[mk]?.bid??results[mk]?.d.c.at(-1)??bars[mk]?.at(-1)?.c;
  const rows=[];
  const close=(k,mk,price,fee,why,t)=>{const V=P[k],x=V.pos[mk],net=x.qty*price*(1-fee),res=net-x.cost;V.cash+=net;V.fees+=x.qty*price*fee;V.closed++;if(res>0)V.wins++;V.pnl+=res;
    rows.push([k,mk,iso(x.t),x.entry,+x.qty.toPrecision(10),iso(t),+price.toPrecision(8),why,(x.fee+x.qty*price*fee).toFixed(3),res.toFixed(3),(res/x.cost*100).toFixed(2)]);delete V.pos[mk]};
  const open=(k,mk,entry,qty,fee,t)=>{const a=results[mk]?.d?.A.at(-1)??entry*0.02,R=riskOf(entry,a),cost=entry*qty*(1+fee);
    P[k].pos[mk]={entry,qty,cost,fee:entry*qty*fee,t,R,stop:entry-R,tp:entry+GEO.tp*R,high:entry};P[k].fees+=entry*qty*fee};
  for(const k of Object.keys(VARIANTS)){const V=P[k];
    // Limit-Kauforders: ausgeführt, sobald der Kurs den Limitpreis erreicht; sonst nach 15 Min storniert
    for(const [mk,o] of Object.entries(V.orders)){const hit=(bars[mk]||[]).find(b=>b.t>=o.t-6e4&&b.l<=o.limit);
      if(hit){delete V.orders[mk];V.cash+=o.reserve;V.cash-=o.limit*o.qty*(1+PAPER.maker);open(k,mk,o.limit,o.qty,PAPER.maker,Math.max(hit.t,o.t))}
      else if(now-o.t>PAPER.limitMin*6e4){V.cash+=o.reserve;delete V.orders[mk];V.storniert++}}
    // Offene Positionen Minute für Minute: Stop-Loss (Marktorder), Ziel (Limit bzw. Markt), nachziehender Stop
    for(const [mk,x] of Object.entries(V.pos)){
      for(const b of bars[mk]||[]){if(b.t<x.t||!V.pos[mk])continue;
        if(b.l<=x.stop){close(k,mk,Math.min(x.stop,b.o),PAPER.taker,x.stop>x.entry?'Nachziehender Stop':'Stop-Loss',b.t);break}
        if(b.h>=x.tp){close(k,mk,k==='limit'?x.tp:Math.max(x.tp,b.o)*0.9995,k==='limit'?PAPER.maker:PAPER.taker,'Ziel',b.t);break}
        x.high=Math.max(x.high,b.h);if(x.high>=x.entry+x.R)x.stop=Math.max(x.stop,x.high-x.R)}
      if(!V.pos[mk])continue;const px=lastPx(mk);if(px==null)continue;
      if(now-x.t>=GEO.h*36e5)close(k,mk,px,PAPER.taker,'Haltedauer',now);
      else if(results[mk]&&results[mk].cal.q<=1)close(k,mk,px,PAPER.taker,'Verkaufssignal',now)}
  }
  // Neue Käufe: dieselben Signale, die du als Push bekommst
  for(const m of markets){const r=results[m.market];if(!r||!eligible(m))continue;const on=r.sig[0]>=LEVEL,prev=P.prevOn[m.market];P.prevOn[m.market]=on;if(!on||prev)continue;
    const bk=BOOK[m.market]||{bid:m.last,ask:m.last};
    for(const k of Object.keys(VARIANTS)){const V=P[k];if(V.pos[m.market]||V.orders[m.market])continue;
      if(Object.keys(V.pos).length+Object.keys(V.orders).length>=PAPER.maxPos||V.cash<PAPER.betrag)continue;
      if(k==='markt'){const q=PAPER.betrag/(bk.ask*(1+PAPER.taker));V.cash-=PAPER.betrag;open(k,m.market,bk.ask,q,PAPER.taker,now)}
      else{const q=PAPER.betrag/(bk.bid*(1+PAPER.maker));V.cash-=PAPER.betrag;V.orders[m.market]={limit:bk.bid,qty:q,reserve:PAPER.betrag,t:now}}}}
  P.lastCheck=now;
  rows.sort((a,b)=>a[5]<b[5]?-1:1);appendCsv(`papier/${iso(now).slice(0,7)}.csv`,HP,rows);
  // Übersicht für die App
  const sum={start:new Date(P.start).toISOString(),stand:new Date(now).toISOString(),betrag:PAPER.betrag,kapital:PAPER.kapital,varianten:{}};
  for(const [k,name] of Object.entries(VARIANTS)){const V=P[k];let val=V.cash;const pos=[];
    for(const [mk,x] of Object.entries(V.pos)){const px=lastPx(mk)??x.entry,v=x.qty*px*(1-PAPER.taker);val+=v;pos.push({markt:mk,kauf:x.entry,seit:new Date(x.t).toISOString(),kurs:px,ergebnis:+(v-x.cost).toFixed(2),stop:+x.stop.toPrecision(6),ziel:+x.tp.toPrecision(6)})}
    for(const o of Object.values(V.orders))val+=o.reserve;
    sum.varianten[k]={name,wert:+val.toFixed(2),ergebnis:+(val-PAPER.kapital).toFixed(2),ergebnis_pct:+((val/PAPER.kapital-1)*100).toFixed(2),realisiert:+V.pnl.toFixed(2),gebuehren:+V.fees.toFixed(2),
      trades:V.closed,gewinner:V.wins,offen:pos,orders:Object.keys(V.orders),storniert:V.storniert}}
  const day=iso(now).slice(0,13);if(!P.curve.length||P.curve.at(-1).t!==day)P.curve.push({t:day,limit:sum.varianten.limit.wert,markt:sum.varianten.markt.wert});else Object.assign(P.curve.at(-1),{limit:sum.varianten.limit.wert,markt:sum.varianten.markt.wert});
  P.curve=P.curve.slice(-24*60);sum.verlauf=P.curve;
  fs.mkdirSync(LOG+'/analyse',{recursive:true});fs.writeFileSync(LOG+'/analyse/papier.json',JSON.stringify(sum));
  console.log(`Papierhandel: Limit ${fmtEur(sum.varianten.limit.ergebnis)} (${Object.keys(P.limit.pos).length} offen, ${Object.keys(P.limit.orders).length} Orders), Markt ${fmtEur(sum.varianten.markt.ergebnis)} (${Object.keys(P.markt.pos).length} offen), ${rows.length} Verkäufe in diesem Lauf`);
}
const fmtEur=v=>(v>=0?'+':'')+v.toFixed(2)+' €';

/* ---------- Trendfolge-Test auf Tageskerzen (einmalig je Version): nur kaufen und halten, kein Hebel, kein Short ---------- */
// Feste, vorab gewählte Regeln (keine Optimierung): Durchschnitt 50, 100 und 200 Tage werden alle gezeigt.
// Kauf/Verkauf jeweils zum Eröffnungskurs des Folgetags, Kosten 0,25 % plus halber Spread je Coin.
const TREND_V=3;
async function trendTest(){
  if(st.trendV===TREND_V)return;const t0=Date.now(),D=864e5,now=Date.now(),start=Date.UTC(2019,0,1),today=Math.floor(now/D)*D;
  const tk=await j(API+'/ticker/24h');
  const cand=tk.filter(x=>x.market?.endsWith('-EUR')&&!STABLE.has(x.market.split('-')[0])&&+x.volumeQuote>=MIN_VOL).map(x=>x.market);if(!cand.includes('BTC-EUR'))cand.push('BTC-EUR');
  const raw={};
  await pool(cand,3,async mk=>{const m=new Map();for(let s=start;s<today;s+=1440*D){const e=Math.min(today-1,s+1440*D-1);
    for(const k of (await j(`${API}/${mk}/candles?interval=1d&limit=1440&start=${s}&end=${e}`))||[]){const t=+k[0];if(t<today)m.set(t,{o:+k[1],c:+k[4],v:+k[5]})}}if(m.size>=60)raw[mk]=m});
  let live={};try{live=JSON.parse(fs.readFileSync(LOG+'/analyse/live.json','utf8')).orderbuch||{}}catch(e){}
  const spr=mk=>clip((live[mk]?.spread??0.3)/200,0.0001,0.01);let FEE_SIM=PAPER.taker;const cost=mk=>FEE_SIM+spr(mk);
  // Welche Coins gibt es gegen USDC (Gebühr 0,05 % statt 0,25 %)?
  let usdcMk=[];try{const ms=await j(API+'/markets'),tv=Object.fromEntries(tk.map(x=>[x.market,+x.volumeQuote||0]));
    usdcMk=ms.filter(m=>m.quote==='USDC'&&m.status==='trading').map(m=>({markt:m.market,volumen_24h_usdc:Math.round(tv[m.market]||0)})).sort((a,b)=>b.volumen_24h_usdc-a.volumen_24h_usdc)}catch(e){console.warn('USDC-Märkte',e.message)}
  // gemeinsame Tagesachse ab dem ersten Bitcoin-Tag
  const B=raw['BTC-EUR'],t0d=Math.min(...B.keys()),days=[];for(let t=t0d;t<today;t+=D)days.push(t);
  const A={};for(const [mk,m] of Object.entries(raw)){const o=[],c=[],ve=[];for(const t of days){const x=m.get(t);o.push(x?x.o:NaN);c.push(x?x.c:NaN);ve.push(x?x.v*x.c:NaN)}
    const cf=[];let last=NaN;for(let i=0;i<days.length;i++){if(c[i]===c[i])last=c[i];cf.push(last)}   // letzter bekannter Kurs, falls ein Tag fehlt
    const sma={};for(const N of [25,50,100,200]){const a=new Array(days.length).fill(NaN);let s=0,n=0;for(let i=0;i<days.length;i++){if(cf[i]!==cf[i])continue;s+=cf[i];n++;
      if(n>N){s-=cf[i-N];n=N}if(n===N)a[i]=s/N}sma[N]=a}
    const v30=new Array(days.length).fill(0);let s=0;for(let i=0;i<days.length;i++){s+=ve[i]===ve[i]?ve[i]:0;if(i>=30)s-=ve[i-30]===ve[i-30]?ve[i-30]:0;v30[i]=s}
    A[mk]={o,c,cf,ve,sma,v30}}
  const i0=days.findIndex((_,i)=>A['BTC-EUR'].sma[200][i]===A['BTC-EUR'].sma[200][i]);
  const topN=n=>i=>Object.entries(A).filter(([mk,a])=>a.ve[i]>=MIN_VOL&&a.v30[i]>=MIN_VOL30&&a.c[i]===a.c[i]).sort((x,y)=>y[1].v30[i]-x[1].v30[i]).slice(0,n).map(x=>x[0]),top10=topN(10),top5=topN(5);
  // Simulation: wants(i) liefert die gewünschten Coins für den nächsten Tag; Gewicht je Coin = w (1 bei Bitcoin, 0,1 bei Top 10)
  function sim(name,w,decideDay,wants){
    let cash=1000,hold={},fees=0,trades=0,inv=0;const eq=[];
    for(let i=i0;i<days.length;i++){
      // Ausführung zum Eröffnungskurs (Entscheid vom Vortag)
      if(i>i0&&decideDay(i-1)){const want=new Set(wants(i-1));
        for(const mk of Object.keys(hold))if(!want.has(mk)){const px=A[mk].o[i]===A[mk].o[i]?A[mk].o[i]:A[mk].cf[i-1];const val=hold[mk]*px,f=val*cost(mk);cash+=val-f;fees+=f;trades++;delete hold[mk]}
        let value=cash;for(const [mk,q] of Object.entries(hold))value+=q*(A[mk].o[i]===A[mk].o[i]?A[mk].o[i]:A[mk].cf[i-1]);
        for(const mk of want)if(!hold[mk]&&A[mk].o[i]===A[mk].o[i]){const amt=Math.min(cash,value*w);if(amt<1)continue;const f=amt*cost(mk);hold[mk]=(amt-f)/A[mk].o[i];cash-=amt;fees+=f;trades++}}
      let v=cash;for(const [mk,q] of Object.entries(hold)){const px=A[mk].cf[i];v+=q*(px===px?px:0)}
      if(Object.keys(hold).length)inv++;eq.push(v)}
    return{name,eq,fees,trades,anteil_investiert:inv/eq.length}}
  const mon=i=>new Date(days[i]).getUTCDay()===1,first=i=>new Date(days[i]).getUTCDate()===1;
  const variants=[['Bitcoin halten',1,i=>i===i0,()=>['BTC-EUR']]];
  for(const N of [25,50,100])variants.push([`Bitcoin mit Trendfilter ${N} Tage`,1,()=>true,i=>A['BTC-EUR'].cf[i]>A['BTC-EUR'].sma[N][i]?['BTC-EUR']:[]]);
  for(const N of [25,50,100])variants.push([`Top 5 mit Trendfilter ${N} Tage (wöchentlich)`,0.2,i=>i===i0||mon(i),i=>top5(i).filter(mk=>A[mk].cf[i]>A[mk].sma[N][i])]);
  variants.push(['Top 10 halten (monatlich neu gewählt)',0.1,i=>i===i0||first(i),top10]);
  for(const N of [50,100,200])variants.push([`Top 10 mit Trendfilter ${N} Tage (wöchentlich)`,0.1,i=>i===i0||mon(i),i=>top10(i).filter(mk=>A[mk].cf[i]>A[mk].sma[N][i])]);
  // je Strategie: Gebühren wie im EUR-Markt (0,25 %) und wie im USDC-Markt (0,05 %, ohne Wechselkurs EUR/USD)
  FEE_SIM=PAPER.taker;const S=variants.map(v=>sim(...v));
  FEE_SIM=0.0005;const SU=variants.map(v=>sim(...v));FEE_SIM=PAPER.taker;
  // Sparplan: jeden Monatsersten 100 € in Bitcoin
  let q=0,inv=0;const dca=[];for(let i=i0;i<days.length;i++){if(i===i0||first(i)){const px=A['BTC-EUR'].o[i]===A['BTC-EUR'].o[i]?A['BTC-EUR'].o[i]:A['BTC-EUR'].cf[i-1];q+=100*(1-cost('BTC-EUR'))/px;inv+=100}dca.push({t:days[i],wert:q*A['BTC-EUR'].cf[i],eingezahlt:inv})}
  // Kennzahlen
  const yrs=(days.length-1-i0)/365,stat=s=>{const e=s.eq;let pk=e[0],dd=0;for(const v of e){pk=Math.max(pk,v);dd=Math.min(dd,v/pk-1)}
    const jahr={};for(let k=0;k<e.length;k++){const y=new Date(days[i0+k]).getUTCFullYear();(jahr[y]||(jahr[y]={a:k>0?e[k-1]:e[0]})).e=e[k]}
    const l12=e.length>365?(e.at(-1)/e[e.length-366]-1)*100:null;
    return{name:s.name,ende:+e.at(-1).toFixed(0),gesamt_pct:+((e.at(-1)/1000-1)*100).toFixed(1),pro_jahr_pct:+((Math.pow(e.at(-1)/1000,1/yrs)-1)*100).toFixed(1),
      max_rueckgang_pct:+(dd*100).toFixed(1),letzte_12_monate_pct:l12!=null?+l12.toFixed(1):null,trades:s.trades,gebuehren:+s.fees.toFixed(0),investiert_pct:Math.round(s.anteil_investiert*100),
      jahre:Object.fromEntries(Object.entries(jahr).map(([y,x])=>[y,+((x.e/x.a-1)*100).toFixed(1)]))}};
  const out={erstellt:new Date().toISOString(),von:new Date(days[i0]).toISOString().slice(0,10),bis:new Date(days.at(-1)).toISOString().slice(0,10),jahre:+yrs.toFixed(1),
    coins_mit_daten:Object.keys(A).length,regeln:{kapital:1000,kosten:'0,25 % + halber Spread je Coin',ausfuehrung:'Eröffnungskurs Folgetag',kein_hebel:true,kein_short:true},
    strategien:S.map((s,k)=>{const a=stat(s),u=stat(SU[k]);return{...a,usdc_ende:u.ende,usdc_pro_jahr_pct:u.pro_jahr_pct,usdc_gebuehren:u.gebuehren}}),usdc_maerkte:usdcMk,sparplan:{eingezahlt:dca.at(-1).eingezahlt,wert:+dca.at(-1).wert.toFixed(0),gewinn_pct:+((dca.at(-1).wert/dca.at(-1).eingezahlt-1)*100).toFixed(1)},
    verlauf:days.slice(i0).map((t,k)=>k%7&&k!==days.length-1-i0?null:{t:new Date(t).toISOString().slice(0,10),...Object.fromEntries(S.map(s=>[s.name,+s.eq[k].toFixed(0)]))}).filter(Boolean)};
  fs.mkdirSync(LOG+'/analyse',{recursive:true});fs.writeFileSync(LOG+'/analyse/trendtest.json',JSON.stringify(out,null,1));
  st.trendV=TREND_V;console.log(`Trendfolge-Test fertig (${Math.round((Date.now()-t0)/1e3)} s, ${out.von} bis ${out.bis}, ${out.coins_mit_daten} Coins)`);
}


/* ---------- USDC-Test (einmalig je Version): Top 5 mit Trendfilter 50 Tage, gehandelt gegen USDC statt EUR ---------- */
// Seriöse Rechnung: nur Coins, die gegen USDC wirklich handelbar sind; Kosten = 0,05 % + halber Spread aus dem USDC-Orderbuch;
// Kurs in US-Dollar = EUR-Kurs × EUR/USD (EZB); Bargeld liegt in USDC; Umtausch EUR→USDC 0,10 % am Anfang und am Ende;
// Ergebnis zusätzlich in Franken (EZB-Kurs EUR/CHF). Empfindlichkeit: 40/50/60 Tage und jeder Wochentag als Umschichttag.
const USDC_V=1;
async function usdcTest(){
  if(st.usdcV===USDC_V)return;const t0=Date.now(),D=864e5,start=Date.UTC(2019,0,1),today=Math.floor(Date.now()/D)*D;
  const tk=await j(API+'/ticker/24h'),ms=await j(API+'/markets'),tv=Object.fromEntries(tk.map(x=>[x.market,+x.volumeQuote||0]));
  const usdcAll=ms.filter(m=>m.quote==='USDC'&&m.status==='trading'&&!STABLE.has(m.base)).map(m=>({markt:m.market,base:m.base,vol:tv[m.market]||0})).sort((a,b)=>b.vol-a.vol);
  const U=usdcAll.filter(x=>x.vol>=MIN_VOL).map(x=>x.base);                     // > 50'000 $ Umsatz am letzten Tag gegen USDC
  const chfMk=ms.filter(m=>m.base.includes('CHF')||m.quote.includes('CHF')).map(m=>m.market);
  // Orderbücher: halber Spread und Kosten einer Marktorder über 200 (drei Momentaufnahmen, Median)
  async function bookCost(mk){const r=[];for(let k=0;k<3;k++){try{const b=await j(`${API}/${mk}/book?depth=50`);const bid=+b.bids[0][0],ask=+b.asks[0][0],mid=(bid+ask)/2;
      let need=200,cost=0;for(const [p,q] of b.asks){const take=Math.min(need,+p*+q);cost+=take*(+p/mid-1);need-=take;if(need<=0)break}
      r.push({half:(ask-bid)/2/mid,slip200:need>0?null:cost/200})}catch(e){}if(k<2)await sleep(4000)}
    if(!r.length)return null;const med=a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[a.length>>1]:null};return{half:med(r.map(x=>x.half)),slip200:med(r.map(x=>x.slip200))}}
  const books={};for(const b of new Set([...U,'BTC'])){books[b+'-USDC']=await bookCost(b+'-USDC');books[b+'-EUR']=await bookCost(b+'-EUR')}
  // Tageskerzen EUR (alle Kandidaten wie im Trendtest) und USDC (zur Kontrolle)
  const cand=tk.filter(x=>x.market?.endsWith('-EUR')&&!STABLE.has(x.market.split('-')[0])&&+x.volumeQuote>=MIN_VOL).map(x=>x.market);for(const b of U)if(!cand.includes(b+'-EUR'))cand.push(b+'-EUR');
  const load=async mk=>{const m=new Map();for(let s=start;s<today;s+=1440*D){const e=Math.min(today-1,s+1440*D-1);
    for(const k of (await j(`${API}/${mk}/candles?interval=1d&limit=1440&start=${s}&end=${e}`))||[]){const t=+k[0];if(t<today)m.set(t,{o:+k[1],c:+k[4],v:+k[5]})}}return m};
  const raw={},rawU={};await pool(cand,3,async mk=>{const m=await load(mk);if(m.size>=60)raw[mk]=m});
  await pool(U.map(b=>b+'-USDC'),2,async mk=>{rawU[mk]=await load(mk)});
  let usdcEur=new Map();try{usdcEur=await load('USDC-EUR')}catch(e){}
  // EZB-Referenzkurse (USD und CHF je EUR), Wochenenden mit letztem Kurs
  const fx={USD:new Map(),CHF:new Map()};let fxQuelle='EZB';
  try{const r=await fetch('https://data-api.ecb.europa.eu/service/data/EXR/D.USD+CHF.EUR.SP00.A?format=csvdata&startPeriod=2018-12-01');if(!r.ok)throw new Error('EZB '+r.status);
    const lines=(await r.text()).trim().split(/\r?\n/),h=lines[0].split(','),ic=h.indexOf('CURRENCY'),it=h.indexOf('TIME_PERIOD'),iv=h.indexOf('OBS_VALUE');
    for(const l of lines.slice(1)){const c=l.split(',');const v=+c[iv];if(v>0&&fx[c[ic]])fx[c[ic]].set(Date.parse(c[it]+'T00:00:00Z'),v)}}
  catch(e){console.warn('EZB-Kurse',e.message);fxQuelle='Bitvavo USDC-EUR (ohne CHF)';for(const [t,x] of usdcEur)fx.USD.set(t,1/x.c)}
  const B=raw['BTC-EUR'],t0d=Math.min(...B.keys()),days=[];for(let t=t0d;t<today;t+=D)days.push(t);
  const ffill=m=>{const a=[];let last=NaN;for(const t of days){if(m.has(t))last=m.get(t);a.push(last)}let first=a.find(x=>x===x);return a.map(x=>x===x?x:first)};
  const usd=ffill(fx.USD),chf=fx.CHF.size?ffill(fx.CHF):null;
  const A={};for(const [mk,m] of Object.entries(raw)){const o=[],c=[],ve=[];for(const t of days){const x=m.get(t);o.push(x?x.o:NaN);c.push(x?x.c:NaN);ve.push(x?x.v*x.c:NaN)}
    const cf=[];let last=NaN;for(let i=0;i<days.length;i++){if(c[i]===c[i])last=c[i];cf.push(last)}
    const v30=new Array(days.length).fill(0);let s=0;for(let i=0;i<days.length;i++){s+=ve[i]===ve[i]?ve[i]:0;if(i>=30)s-=ve[i-30]===ve[i-30]?ve[i-30]:0;v30[i]=s}
    // Kurse in USD (für den USDC-Handel) und die Durchschnitte in beiden Währungen
    const ou=o.map((x,i)=>x*usd[i]),cu=cf.map((x,i)=>x*usd[i]);
    const smaOf=(arr,N)=>{const a=new Array(days.length).fill(NaN);let s=0,n=0;for(let i=0;i<days.length;i++){if(arr[i]!==arr[i])continue;s+=arr[i];n++;if(n>N){s-=arr[i-N];n=N}if(n===N)a[i]=s/N}return a};
    const sma={},smaU={};for(const N of [40,50,60]){sma[N]=smaOf(cf,N);smaU[N]=smaOf(cu,N)}
    A[mk]={o,c,cf,ve,v30,ou,cu,sma,smaU}}
  // Kontrolle: weicht EUR-Kurs × EUR/USD vom echten USDC-Kurs ab?
  const kontrolle={};for(const [mk,m] of Object.entries(rawU)){const e=A[mk.replace('-USDC','-EUR')];if(!e)continue;const d=[];
    days.forEach((t,i)=>{const x=m.get(t);if(x&&e.c[i]===e.c[i])d.push(Math.abs(x.c/(e.c[i]*usd[i])-1))});d.sort((a,b)=>a-b);
    kontrolle[mk]={gelistet_seit:m.size?new Date(Math.min(...m.keys())).toISOString().slice(0,10):null,tage:d.length,median_abweichung_pct:d.length?+(d[d.length>>1]*100).toFixed(2):null}}
  const i0=days.findIndex(t=>t>=Date.UTC(2019,8,23));
  const spr=(mk)=>clip(books[mk]?.half??0.003,0.0001,0.01);
  let live={};try{live=JSON.parse(fs.readFileSync(LOG+'/analyse/live.json','utf8')).orderbuch||{}}catch(e){}
  const sprE=mk=>books[mk]?.half!=null?clip(books[mk].half,0.0001,0.01):clip((live[mk]?.spread??0.3)/200,0.0001,0.01);
  const elig=(mk,i)=>A[mk]&&A[mk].ve[i]>=MIN_VOL&&A[mk].v30[i]>=MIN_VOL30&&A[mk].c[i]===A[mk].c[i];
  const top5=pool_=>i=>pool_.filter(mk=>elig(mk,i)).sort((x,y)=>A[y].v30[i]-A[x].v30[i]).slice(0,5);
  const allE=Object.keys(A),uE=U.map(b=>b+'-EUR').filter(mk=>A[mk]);
  // Simulation; ccy 'EUR' = Handel gegen EUR, 'USD' = Handel gegen USDC (Kurse in USD, Bargeld in USDC)
  function sim({name,ccy,fee,universe,N,wd,w=0.2,filter=true}){
    const O=mk=>ccy==='USD'?A[mk].ou:A[mk].o,C=mk=>ccy==='USD'?A[mk].cu:A[mk].cf,S=mk=>ccy==='USD'?A[mk].smaU[N]:A[mk].sma[N];
    const cost=mk=>fee+(ccy==='USD'?spr(mk.replace('-EUR','-USDC')):sprE(mk));
    const pick=top5(universe);const wants=i=>{const p=pick(i);return filter?p.filter(mk=>C(mk)[i]>S(mk)[i]):p};
    // Start: 1000 CHF (bzw. Gegenwert) → EUR → bei USDC zusätzlich 0,10 % Umtausch
    let cash=ccy==='USD'?eur0*usd[i0]*(1-0.001):eur0,hold={},fees=ccy==='USD'?eur0*0.001:0,trades=0,inv=0;const eq=[];
    for(let i=i0;i<days.length;i++){
      if(i>i0&&(i-1===i0||new Date(days[i-1]).getUTCDay()===wd)){const want=new Set(wants(i-1));
        const px=mk=>O(mk)[i]===O(mk)[i]?O(mk)[i]:C(mk)[i-1];
        for(const mk of Object.keys(hold))if(!want.has(mk)){const val=hold[mk]*px(mk),f=val*cost(mk);cash+=val-f;fees+=f;trades++;delete hold[mk]}
        let value=cash;for(const [mk,q] of Object.entries(hold))value+=q*px(mk);
        for(const mk of want)if(!hold[mk]&&O(mk)[i]===O(mk)[i]){const amt=Math.min(cash,value*w);if(amt<1)continue;const f=amt*cost(mk);hold[mk]=(amt-f)/O(mk)[i];cash-=amt;fees+=f;trades++}}
      let v=cash;for(const [mk,q] of Object.entries(hold)){const p=C(mk)[i];v+=q*(p===p?p:0)}
      if(Object.keys(hold).length)inv++;
      // Wert in EUR und CHF (bei USDC am Schluss wieder zurück in EUR: −0,10 %)
      const vE=ccy==='USD'?v/usd[i]*(i===days.length-1?0.999:1):v;eq.push({lokal:v,eur:vE,chf:chf?vE*chf[i]:null})}
    return{name,ccy,eq,fees,trades,inv:inv/eq.length}}
  const yrs=(days.length-1-i0)/365,eur0=chf?1000/chf[i0]:1000;
  const kenn=(e,start)=>{let pk=e[0],dd=0;for(const v of e){pk=Math.max(pk,v);dd=Math.min(dd,v/pk-1)}const l12=e.length>365?(e.at(-1)/e[e.length-366]-1)*100:null;
    const jahr={};for(let k=0;k<e.length;k++){const y=new Date(days[i0+k]).getUTCFullYear();(jahr[y]||(jahr[y]={a:k>0?e[k-1]:start})).e=e[k]}
    return{ende:+e.at(-1).toFixed(0),pro_jahr_pct:+((Math.pow(e.at(-1)/start,1/yrs)-1)*100).toFixed(1),max_rueckgang_pct:+(dd*100).toFixed(1),letzte_12_monate_pct:l12==null?null:+l12.toFixed(1),
      jahre:Object.fromEntries(Object.entries(jahr).map(([y,x])=>[y,+((x.e/x.a-1)*100).toFixed(1)]))}};
  const stat=s=>({name:s.name,waehrung:s.ccy==='USD'?'USDC':'EUR',trades:s.trades,gebuehren_lokal:+s.fees.toFixed(0),investiert_pct:Math.round(s.inv*100),
    in_chf:chf?kenn(s.eq.map(x=>x.chf),1000):null,in_eur:kenn(s.eq.map(x=>x.eur),eur0),in_handelswaehrung:kenn(s.eq.map(x=>x.lokal),s.ccy==='USD'?eur0*usd[i0]:eur0)});
  const fE=PAPER.taker,fU=0.0005,MON=1;
  const haupt=[
    {name:'Top 5 mit Trendfilter 50 Tage, gegen EUR (alle Coins)',ccy:'EUR',fee:fE,universe:allE,N:50,wd:MON},
    {name:'Top 5 mit Trendfilter 50 Tage, gegen EUR (nur Coins mit USDC-Markt)',ccy:'EUR',fee:fE,universe:uE,N:50,wd:MON},
    {name:'Top 5 mit Trendfilter 50 Tage, gegen USDC',ccy:'USD',fee:fU,universe:uE,N:50,wd:MON},
    {name:'Top 5 ohne Filter gegen USDC (wöchentlich neu gewählt)',ccy:'USD',fee:fU,universe:uE,N:50,wd:MON,filter:false},
    {name:'Bitcoin mit Trendfilter 50 Tage, gegen USDC',ccy:'USD',fee:fU,universe:['BTC-EUR'],N:50,wd:MON,w:1},
    {name:'Bitcoin halten, gegen USDC',ccy:'USD',fee:fU,universe:['BTC-EUR'],N:50,wd:-1,w:1,filter:false}].map(v=>stat(sim(v)));
  // Empfindlichkeit der USDC-Variante: Durchschnitt 40/50/60 × Umschichttag Mo–So
  const emp=[];for(const N of [40,50,60])for(let wd=0;wd<7;wd++){const s=stat(sim({name:`${N} Tage, Tag ${wd}`,ccy:'USD',fee:fU,universe:uE,N,wd}));emp.push({tage:N,wochentag:['So','Mo','Di','Mi','Do','Fr','Sa'][wd],pro_jahr_chf:s.in_chf?.pro_jahr_pct??s.in_eur.pro_jahr_pct,rueckgang_chf:s.in_chf?.max_rueckgang_pct??s.in_eur.max_rueckgang_pct,letzte_12m:s.in_chf?.letzte_12_monate_pct})}
  const pj=emp.map(x=>x.pro_jahr_chf).sort((a,b)=>a-b);
  const fxEnt=k=>({start:+k[i0].toFixed(4),ende:+k.at(-1).toFixed(4),veraenderung_pct:+((k.at(-1)/k[i0]-1)*100).toFixed(1)});
  const out={erstellt:new Date().toISOString(),version:USDC_V,von:new Date(days[i0]).toISOString().slice(0,10),bis:new Date(days.at(-1)).toISOString().slice(0,10),jahre:+yrs.toFixed(1),
    start:'1000 CHF',wechselkurse:{quelle:fxQuelle,usd_je_eur:fxEnt(usd),chf_je_eur:chf?fxEnt(chf):null,chf_je_usd:chf?fxEnt(chf.map((c,i)=>c/usd[i])):null},
    usdc_universum:U,usdc_maerkte:usdcAll.map(x=>({markt:x.markt,volumen_24h_usdc:Math.round(x.vol)})),chf_maerkte_bitvavo:chfMk,
    orderbuch:Object.fromEntries(Object.entries(books).map(([k,v])=>[k,v&&{halber_spread_pct:v.half==null?null:+(v.half*100).toFixed(3),marktorder_200_pct:v.slip200==null?null:+(v.slip200*100).toFixed(3)}])),
    kontrolle_usdc_kurs:kontrolle,strategien:haupt,empfindlichkeit:{varianten:emp,pro_jahr_chf_min:pj[0],pro_jahr_chf_median:pj[pj.length>>1],pro_jahr_chf_max:pj.at(-1)}};
  fs.mkdirSync(LOG+'/analyse',{recursive:true});fs.writeFileSync(LOG+'/analyse/usdctest.json',JSON.stringify(out,null,1));
  st.usdcV=USDC_V;console.log(`USDC-Test fertig (${Math.round((Date.now()-t0)/1e3)} s)`);
}

/* ---------- Hauptlauf ---------- */
async function main(){
  await readCommands().catch(e=>console.warn('Befehle',e.message));
  const t=await j(API+'/ticker/24h');
  const tick24=Object.fromEntries(t.map(x=>[x.market,x]));
  markets=t.filter(x=>x.market&&x.market.endsWith('-EUR')&&!STABLE.has(x.market.split('-')[0])&&+x.last>0&&(+x.volumeQuote>=MIN_VOL||st.pos[x.market]))
    .map(x=>({market:x.market,base:x.market.split('-')[0],last:+x.last,vol:+x.volumeQuote,chg:x.open>0?(x.last-x.open)/x.open*100:0}));
  console.log(`${markets.length} Märkte über 50k € in 24h, Zeiteinheit ${TF}, ${Object.keys(st.pos).length} eigene Positionen`);
  await pool(markets,5,async m=>{const rows=(await j(`${API}/${m.market}/candles?interval=${TF}&limit=${HIST}`)).slice().reverse();if(rows.length>=220)data[m.market]=prep(rows,m.market)});
  markets.forEach(m=>{const d=data[m.market];if(d){m.vol3d=vol3d(d);m.vol30d=volSum(d,720)??vol3d(d)*10}});
  markets=markets.filter(m=>data[m.market]&&(eligible(m)||st.pos[m.market]));
  for(const k of Object.keys(data))if(!markets.find(m=>m.market===k))delete data[k];
  console.log(`${markets.filter(eligible).length} Märkte erfüllen den Filter (>50k €/24h, >1 Mio. €/30 Tage).`);
  await log1m().catch(e=>console.warn('1-Minuten-Log',e.message));
  await repair1m().catch(e=>console.warn('Reparatur 1-Minuten-Log',e.message));
  await logExt().catch(e=>console.warn('Zusatzdaten',e.message));
  // Umstellung auf 12 Monate: Analysen und Modell einmalig neu berechnen (die bekannte Warnung nicht erneut senden)
  if(st.featV!==2){st.featV=2;st.featAt=0}                                   // neue Merkmalgruppen gleich prüfen
  if(st.longV!==LONG_V){st.longV=LONG_V;st.geoAt=0;st.featAt=0;st.model=null;if(st.edge===undefined&&st.geo)st.edge=false}
  if(st.geo)GEO={...GEO,...st.geo};
  setFeatSet(st.featSet||'v1');
  const due=!st.winAt||!st.featAt||!st.model||st.model.tf!==TF||st.model.merkmale!==(st.featSet||'v1')||Date.now()-(st.modelAt||0)>DAY_MS;
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
    if(c.kind==='add'){const s=c.snap,p=st.pos[c.mk];await push(c.nach?`Nachkauf eingetragen: ${b}`:`Kauf eingetragen: ${b}`,(c.nach?`+${c.nach} zu ${fmtP(c.preis)} €. Neuer Durchschnittspreis ${fmtP(s.buy)} €, Bestand ${+s.qty.toFixed(8)}`:`Kaufpreis ${fmtP(s.buy)} €${s.qty?`, Menge ${s.qty}`:''}`)+`${s.cost?`, Einsatz inkl. Gebühr ${s.cost.toFixed(2)} €`:''}.`+(p&&p.stop!=null?` Stop ${fmtP(p.stop)} €, Ziel ${fmtP(p.tp)} €. Ich melde mich, sobald du verkaufen solltest.`:''),3,'white_check_mark')}
    else if(c.kind==='part')await push(`Teilverkauf eingetragen: ${b}`,`${+c.q.toFixed(8)} verkauft${c.sell?` zu ${fmtP(c.sell)} €`:''}${c.net!=null?`, Erlös nach Gebühr ${c.net.toFixed(2)} €`:''}${c.eur!=null?`, Ergebnis ${c.eur>=0?'+':''}${c.eur.toFixed(2)} €`:''}. Restbestand ${+c.rest.toFixed(8)}, wird weiter überwacht.`,3,'white_check_mark');
    else if(c.kind==='del')await push(`Verkauf eingetragen: ${b}`,c.sell?`Ergebnis ${c.eur!=null?`${c.eur>=0?'+':''}${c.eur.toFixed(2)} € nach Gebühren`:pct(((c.sell*(1-FEE))/(c.buy*(1+FEE))-1)*100)+' nach Gebühren'} (Kauf ${fmtP(c.buy)} €, Verkauf ${fmtP(c.sell)} €).`:'Position entfernt.',3,'white_check_mark');
    else if(c.kind==='unknown')await push(`${b} nicht im Bestand`,'Zu diesem Coin ist kein Kauf eingetragen.',2,'grey_question');
    else if(c.kind==='list'){const L=Object.entries(st.pos);await push('Deine Positionen',L.length?L.map(([mk,p])=>{const last=+(tick24[mk]?.last||0);const a=advice(mk,p,last);return `${mk.replace('-EUR','')}: ${pct(a.pnl)}${a.eur!=null?` (${a.eur>=0?'+':''}${a.eur.toFixed(2)} €)`:''} · ${a.label}`}).join('\n'):'Keine Positionen eingetragen.',2,'clipboard')}
    else await push('Befehl nicht verstanden',`«${c.t.slice(0,60)}». Beispiele: «kauf BTC 61500 0.02», «verkauf BTC 63000» (alles), «verkauf BTC 63000 0.01» (Teil), «liste».`,2,'grey_question');
  }
  for(const s of sells)await push(s.t,s.b,5,'warning');
  buys.sort((a,b)=>b.ev-a.ev);
  for(const b of buys.slice(0,4))await push(b.t,b.b,4);
  if(buys.length>4)await push(`${buys.length-4} weitere Kauf-Signale`,buys.slice(4).map(b=>b.t.split(': ')[1]).join(', '),3);
  if(!st.ok)await push('Bitvavo-Bot läuft wieder','Daten werden wieder normal abgerufen.',2,'white_check_mark');
  st.ok=true;
  try{retro()}catch(e){console.warn('Rückblick',e.message)}
  await paperStep().catch(e=>console.warn('Papierhandel',e.message));
  logRun(buys);
  await trendTest().catch(e=>console.warn('Trendfolge-Test',e.stack||e.message));
  await usdcTest().catch(e=>console.warn('USDC-Test',e.stack||e.message));
  console.log(`Fertig: ${buys.length} neue Kauf-Signale, ${sells.length} Verkaufsmeldungen, ${confirmations.length} Eingaben.`);
}

loadState();
// Optional: Positionen weiterhin auch per Secret POSITIONS
try{for(const p of JSON.parse(process.env.POSITIONS||'[]')){const mk=(p.coin||'').toUpperCase().replace(/-EUR$/,'')+'-EUR';if(+p.buy>0&&!st.pos[mk])st.pos[mk]={buy:+p.buy,qty:p.qty?+p.qty:null,t:Date.now()}}}catch(e){}
try{await main()}
catch(e){console.error(e);if(st.ok)await push('Bitvavo-Bot: Fehler',String(e.message||e).slice(0,200),3,'x');st.ok=false;process.exitCode=1}
finally{try{housekeeping()}catch(e){console.warn('Aufräumen',e.message)}saveState()}
