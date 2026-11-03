// Bitvavo Signal-Bot: prüft alle EUR-Märkte mit > 250k € Volumen, lernt aus dem Kursverlauf
// und schickt Kauf- und Verkaufssignale per ntfy aufs Handy. Gleiche Logik wie die Radar-App.
import fs from 'node:fs';
const API='https://api.bitvavo.com/v2';
const CG='https://api.coingecko.com/api/v3';
const MIN_VOL=250000;
const SRBARS={'15m':96,'1h':48,'4h':30};   // Bars für Unterstützung/Widerstand
const DAY={'15m':96,'1h':24,'4h':6};       // Bars pro 24h
const HOR={'15m':16,'1h':8,'4h':6};        // Haltedauer im Backtest: 4h / 8h / 24h
const TFMS={'15m':9e5,'1h':36e5,'4h':144e5};
let TPm=1.5, SLm=1;                       // Ziel +1,5 ATR, Stop −1 ATR
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
function prep(cand){
  const ts=cand.map(x=>+x[0]),o=cand.map(x=>+x[1]),h=cand.map(x=>+x[2]),l=cand.map(x=>+x[3]),c=cand.map(x=>+x[4]),v=cand.map(x=>+x[5]);
  const e12=ema(c,12),e26=ema(c,26),mm=c.map((_,i)=>e12[i]-e26[i]),ms=ema(mm,9),mh=mm.map((x,i)=>x-ms[i]);
  const B=boll(c),bw=B.map((b,i)=>b?(b.u-b.l)/b.m:null),vr=v.map((x,i)=>{if(i<20)return 1;let s=0;for(let k=i-20;k<i;k++)s+=v[k];return x/((s/20)||1e-9)});
  return{ts,o,h,l,c,v,e20:ema(c,20),e50:ema(c,50),e200:ema(c,200),R:rsi(c),mh,B,bw,A:atr(h,l,c),vr};
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
];
const K=FEATS.length;
const feat=(d,i)=>FEATS.map(F=>F.f(d,i));

/* Ergebnis eines Kaufs bei Kerze i: Ziel vor Stop? */
function outcome(d,i){
  const e=d.c[i],a=d.A[i],tp=e+TPm*a,sl=e-SLm*a,H=HOR[TF];
  for(let k=i+1;k<=i+H&&k<d.c.length;k++){if(d.l[k]<=sl)return{y:0,r:-1};if(d.h[k]>=tp)return{y:1,r:TPm}}
  const k=Math.min(i+H,d.c.length-1);return{y:0,r:(d.c[k]-e)/(SLm*a)};
}

/* ---------- Lernen: logistische Regression ---------- */
function fit(X,y,n,iters=160){
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
function predict(m,x){let s=m.b;for(let k=0;k<K;k++)s+=m.w[k]*(x[k]-m.mu[k])/m.sd[k];return 1/(1+Math.exp(-s))}
function contrib(m,x){return x.map((v,k)=>m.w[k]*(v-m.mu[k])/m.sd[k])}

async function trainModel(){
  setStat('Lerne aus der Vergangenheit: sammle Beispiele…','');await tick();
  const S=[];const H=HOR[TF];
  for(const mk of Object.keys(data)){const d=data[mk];for(let i=210;i<d.c.length-H;i++){if(!d.A[i])continue;const o=outcome(d,i);S.push({mk,ts:d.ts[i],x:feat(d,i),y:o.y,r:o.r})}}
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
  FEATS.forEach((F,k)=>{const active=F.num?Math.abs(ct[k])>.04:x[k]!==0;if(active)reasons.push([ct[k],F.t(x[k],d,N)])});
  reasons.sort((a,b)=>Math.abs(b[0])-Math.abs(a[0]));
  const lb=SRBARS[TF],sup=Math.min(...d.l.slice(-lb)),res=Math.max(...d.h.slice(-lb)),a=d.A[N];
  const stop=last-SLm*a,t1=last+TPm*a,t2=res>t1?res:last+2.5*a;
  const sig=ev>=.25?[2,'Starker Kauf']:ev>=.08?[1,'Kauf']:ev>-.08?[0,'Neutral']:ev>-.25?[-1,'Meiden']:[-2,'Verkaufen'];
  return{p,cal,ev,score:Math.round(clip(ev*100,-100,100)),sig,reasons,rsi:d.R[N],atrPct:a/last*100,volR:d.vr[N],sup,res,stop,t1,t2,
    trend:last>d.e50[N]?(d.e20[N]>d.e50[N]?'aufwärts':'erholt'):(d.e20[N]<d.e50[N]?'abwärts':'schwach'),d};
}


let TF=process.env.TF||'1h', markets=[], data={}, results={}, model=null, lastTrain=0;
const setStat=t=>console.log(t), tick=async()=>{};

const TOPIC=(process.env.NTFY_TOPIC||'').trim();
const LEVEL=+(process.env.MIN_LEVEL||2);               // 2 = nur Starker Kauf, 1 = ab Kauf
let POS=[];
try{POS=JSON.parse(process.env.POSITIONS||'[]')}catch(e){console.error('POSITIONS ist kein gültiges JSON:',e.message)}
POS=POS.map(p=>({m:(p.coin||p.market||'').toUpperCase().replace(/-EUR$/,'')+'-EUR',buy:+p.buy,qty:p.qty?+p.qty:null})).filter(p=>p.buy>0);
const STATE='state/state.json';
let st={notified:{},pos:{},ok:true};
try{st={...st,...JSON.parse(fs.readFileSync(STATE,'utf8'))}}catch(e){console.log('Kein gespeicherter Zustand, erster Lauf.')}

/* ---------- Logbuch (Branch "logs", ältere Daten als 3 Jahre werden gelöscht) ---------- */
const LOG=process.env.LOG_DIR||'', KEEP_YEARS=3, T0=Date.now();
const iso=d=>d.toISOString().slice(0,19).replace('T',' ');
const csvq=v=>{v=v==null?'':String(v);return /[",\n;]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
function appendCsv(rel,header,rows){
  if(!LOG||!rows.length)return;const f=LOG+'/'+rel;fs.mkdirSync(f.slice(0,f.lastIndexOf('/')),{recursive:true});
  if(!fs.existsSync(f))fs.writeFileSync(f,header.join(',')+'\n');
  fs.appendFileSync(f,rows.map(r=>r.map(csvq).join(',')).join('\n')+'\n');
}
function prune(){
  if(!LOG||!fs.existsSync(LOG))return;
  const cut=new Date();cut.setUTCFullYear(cut.getUTCFullYear()-KEEP_YEARS);let n=0;
  const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=dir+'/'+e.name;
    if(e.isDirectory()){walk(p);if(!fs.readdirSync(p).length)fs.rmdirSync(p);continue}
    const m=e.name.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?\.csv$/);if(!m)continue;
    const end=m[3]?new Date(Date.UTC(+m[1],+m[2]-1,+m[3]+1)):new Date(Date.UTC(+m[1],+m[2],1));
    if(end<cut){fs.unlinkSync(p);n++}}};
  walk(LOG);if(n)console.log(`${n} Logdateien älter als ${KEEP_YEARS} Jahre gelöscht.`);
}
function writeLogs(buys){
  if(!LOG)return;const now=new Date(),day=now.toISOString().slice(0,10),mon=day.slice(0,7),t=iso(now);
  const all=Object.values(results);
  appendCsv(`laeufe/${mon}.csv`,['zeit_utc','zeiteinheit','maerkte','kauf_signale','meiden_verkaufen','modell_signale','basis_trefferquote','top10_trefferquote','top10_ergebnis_r','btc_eur','dauer_s'],
    [[t,TF,markets.filter(m=>m.vol>=MIN_VOL).length,all.filter(r=>r.sig[0]>0).length,all.filter(r=>r.sig[0]<0).length,model.n,model.baseWin.toFixed(3),model.top.win.toFixed(3),model.top.r.toFixed(3),markets.find(m=>m.market==='BTC-EUR')?.last??'',((Date.now()-T0)/1000).toFixed(0)]]);
  // Voller Marktschnappschuss einmal pro Stunde
  const hour=now.toISOString().slice(0,13);
  if(st.lastSnap!==hour){st.lastSnap=hour;
    appendCsv(`markt/${day.slice(0,4)}/${day}.csv`,['zeit_utc','markt','preis_eur','volumen_24h_eur','veraenderung_24h_pct','rsi','treffer_wahrsch','erwartung_r','signal'],
      markets.filter(m=>results[m.market]&&m.vol>=MIN_VOL).map(m=>{const r=results[m.market];return[t,m.market,m.last,Math.round(m.vol),m.chg.toFixed(2),r.rsi.toFixed(1),r.p.toFixed(3),r.ev.toFixed(3),r.sig[1]]}));}
  // Gesendete Kauf-Signale (Verkaufsmeldungen nicht, die verraten deine Positionen)
  appendCsv(`meldungen/${mon}.csv`,['zeit_utc','titel','text'],buys.map(b=>[t,b.t,b.b]));
}

async function j(url,tries=3){for(let t=0;t<tries;t++){try{const r=await fetch(url);if(r.ok)return r.json();if(r.status<500&&r.status!==429)throw new Error(url.split('?')[0]+' → '+r.status)}catch(e){if(t===tries-1)throw e}await new Promise(r=>setTimeout(r,1500*(t+1)))}throw new Error(url+' nicht erreichbar')}
async function pool(items,n,fn){let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const it=items[i++];try{await fn(it)}catch(e){console.warn(it.market,e.message)}}}))}
async function push(title,message,prio=4,tag='chart_with_upwards_trend'){
  console.log('PUSH',title,'|',message);
  if(!TOPIC)return;
  const r=await fetch('https://ntfy.sh/',{method:'POST',body:JSON.stringify({topic:TOPIC,title,message,priority:prio,tags:[tag]})});
  if(!r.ok)console.warn('ntfy',r.status,await r.text());
}

function advice(p,last){
  const r=results[p.m],a=r?r.d.A[r.d.c.length-1]:last*0.02,s=st.pos[p.m];
  const pnl=(last/p.buy-1)*100,eur=p.qty?(last-p.buy)*p.qty:null;
  const trail=s.high>=p.buy+a?s.high-2*a:-Infinity,eff=Math.max(s.tpHit?Math.max(s.stop,p.buy):s.stop,trail),o={pnl,eur,eff,last};
  if(last<=eff)return{...o,act:'stop',label:'Verkaufen',why:eff>=p.buy?`Nachlaufender Stop bei ${fmtP(eff)} € unterschritten, Gewinn sichern`:`Stop-Loss bei ${fmtP(eff)} € erreicht, Verlust begrenzen`};
  if(last>=s.tp)return{...o,act:'take',label:'Gewinn mitnehmen',why:`Ziel ${fmtP(s.tp)} € erreicht: etwa die Hälfte verkaufen, Stop für den Rest auf Einstand ${fmtP(p.buy)} €`};
  if(r&&r.sig[0]<=-1)return{...o,act:'signal',label:'Verkaufen',why:`Modell sieht keinen Vorteil mehr (${fmtR(r.ev)} pro Trade)`};
  if(r&&pnl>0&&r.rsi>75)return{...o,act:'secure',label:'Teilgewinn sichern',why:`RSI ${r.rsi.toFixed(0)} stark überkauft`};
  return{...o,act:'hold',label:'Halten',why:`Stop ${fmtP(eff)} €, Ziel ${fmtP(s.tp)} €`};
}

async function main(){
  const t=await j(API+'/ticker/24h');
  const tick24=Object.fromEntries(t.map(x=>[x.market,x]));
  markets=t.filter(x=>x.market&&x.market.endsWith('-EUR')&&+x.last>0&&(+x.volumeQuote>=MIN_VOL||POS.some(p=>p.m===x.market)))
    .map(x=>({market:x.market,base:x.market.split('-')[0],last:+x.last,vol:+x.volumeQuote,chg:x.open>0?(x.last-x.open)/x.open*100:0}));
  console.log(`${markets.length} Märkte, Zeiteinheit ${TF}`);
  await pool(markets,5,async m=>{const rows=(await j(`${API}/${m.market}/candles?interval=${TF}&limit=${HIST}`)).slice().reverse();if(rows.length>=220)data[m.market]=prep(rows)});
  await trainModel();
  console.log(`Modell: ${model.n} Signale, Basis ${(model.baseWin*100).toFixed(0)}%, Top-10% ${(model.top.win*100).toFixed(0)}%`);
  markets.forEach(m=>{if(data[m.market])results[m.market]=analyze(m,data[m.market])});

  const now=Date.now(),buys=[],sells=[];
  for(const m of markets){const r=results[m.market];if(!r||m.vol<MIN_VOL)continue;
    const key='b:'+m.market+':'+TF,on=r.sig[0]>=LEVEL,prev=st.notified[key];
    if(on&&!(prev&&prev.s))buys.push({t:`${r.sig[1]}: ${m.base} (${TF})`,b:`Kurs ${fmtP(m.last)} € · Treffer-W. ${(r.p*100).toFixed(0)}% · Stop ${fmtP(r.stop)} € · Ziel ${fmtP(r.t1)} €`,ev:r.ev});
    st.notified[key]={s:on,t:now}}
  for(const p of POS){const tk=tick24[p.m];if(!tk){console.warn('Kein Kurs für',p.m);continue}
    const last=+tk.last,a=results[p.m]?results[p.m].d.A.at(-1):last*0.02;
    const s=st.pos[p.m];if(!s||s.buy!==p.buy)st.pos[p.m]={buy:p.buy,stop:p.buy-1.5*a,tp:p.buy+2*a,high:Math.max(p.buy,last),tpHit:false};
    st.pos[p.m].high=Math.max(st.pos[p.m].high,last);
    const adv=advice(p,last);if(last>=st.pos[p.m].tp)st.pos[p.m].tpHit=true;
    const key='s:'+p.m,prev=st.notified[key];
    console.log(`Position ${p.m}: ${adv.label} (${pct(adv.pnl)})`);
    if(adv.act!=='hold'&&!(prev&&prev.s===adv.act))sells.push({t:`${adv.label}: ${p.m.replace('-EUR','')}`,b:`${adv.why}. ${pct(adv.pnl)} seit Kauf${adv.eur!=null?` (${adv.eur>=0?'+':''}${adv.eur.toFixed(2)} €)`:''}, Kurs ${fmtP(last)} €`});
    st.notified[key]={s:adv.act,t:now}}
  for(const k of Object.keys(st.pos))if(!POS.some(p=>p.m===k)){delete st.pos[k];delete st.notified['s:'+k]}

  for(const s of sells)await push(s.t,s.b,5,'warning');
  buys.sort((a,b)=>b.ev-a.ev);
  for(const b of buys.slice(0,4))await push(b.t,b.b,4);
  if(buys.length>4)await push(`${buys.length-4} weitere Kauf-Signale`,buys.slice(4).map(b=>b.t.split(': ')[1]).join(', '),3);
  if(!st.ok)await push('Bitvavo-Bot läuft wieder','Daten werden wieder normal abgerufen.',2,'white_check_mark');
  st.ok=true;
  writeLogs(buys);
  console.log(`Fertig: ${buys.length} neue Kauf-Signale, ${sells.length} Verkaufsmeldungen.`);
}

try{await main()}
catch(e){console.error(e);if(st.ok)await push('Bitvavo-Bot: Fehler',String(e.message||e).slice(0,200),3,'x');st.ok=false;process.exitCode=1}
finally{try{prune()}catch(e){console.warn('Aufräumen',e.message)}fs.mkdirSync('state',{recursive:true});fs.writeFileSync(STATE,JSON.stringify(st))}
