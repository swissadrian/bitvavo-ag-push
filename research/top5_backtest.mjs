// Rückwärtstest «Top 5 mit Trendfilter 50 Tage» auf USD-Basis, ohne Rückschau-Effekt.
// Rangliste: CoinMarketCap-Monatsliste (erster Sonntag im Monat, Marktkapitalisierung), ohne Stablecoins und verpackte Token.
// Kurse: Tageskerzen gegen USDT (Binance) bzw. USD (Bitfinex); Lücken aus Bitvavo (EUR × EZB-Kurs).
// Regeln wie im Tool: 1000 € → USDC (0,10 %), 5 % Reserve in USDC, 19 % je Coin der Top 5, solange der Tagesschluss über
// dem 50-Tage-Durchschnitt liegt, sonst bleibt der Anteil in USDC. Entscheid am Tagesschluss, Ausführung zum Eröffnungskurs
// des Folgetags. Gewichte werden nachgezogen, wenn ein Coin mehr als 5 Prozentpunkte vom Ziel abweicht.
import fs from 'node:fs';
const D=864e5, START_FETCH=Date.UTC(2018,8,1), TODAY=Math.floor(Date.now()/D)*D;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url,type='json',tries=4){for(let t=0;t<tries;t++){try{const r=await fetch(url);if(r.ok)return type==='json'?r.json():r.text();
  if(r.status===429){await sleep(5000*(t+1));continue}if(r.status<500)return null}catch(e){}await sleep(1500*(t+1))}return null}
const STABLE=new Set(['USDT','USDC','BUSD','DAI','UST','TUSD','USDE','FDUSD','PYUSD','USDS','WBTC','STETH','WETH','WSTETH','LEO','TAGZ5']);

// --- Rangliste
const ranks=fs.readFileSync(new URL('./cmc_top_monatlich.csv',import.meta.url),'utf8').trim().split('\n').slice(1).map(l=>{const [d,s]=l.split(',');
  return{t:Date.parse(d+'T00:00:00Z'),list:s.trim().split(/\s+/).filter(x=>!STABLE.has(x))}});
const coins=[...new Set(ranks.flatMap(r=>r.list.slice(0,6)))];
const topAt=t=>{let r=null;for(const x of ranks)if(x.t<=t)r=x;return r?r.list:[]};

// --- Kurse
const BIN={BCH:['BCHUSDT','BCHABCUSDT'],BSV:['BCHSVUSDT','BSVUSDT'],LUNA:['LUNAUSDT','LUNCUSDT'],MATIC:['MATICUSDT','POLUSDT']};
const BFX={BTC:['tBTCUSD'],ETH:['tETHUSD'],XRP:['tXRPUSD'],BCH:['tBCHN:USD','tBABUSD','tBCHUSD'],EOS:['tEOSUSD'],LTC:['tLTCUSD'],XLM:['tXLMUSD'],BSV:['tBSVUSD'],
  BNB:['tBNBUSD'],LINK:['tLINK:USD'],DOT:['tDOTUSD'],ADA:['tADAUSD'],DOGE:['tDOGE:USD'],SOL:['tSOLUSD'],LUNA:['tLUNA:USD'],TRX:['tTRXUSD'],TON:['tTONUSD'],AVAX:['tAVAX:USD']};
async function binance(sym){const m=new Map();let s=START_FETCH;for(let k=0;k<12&&s<TODAY;k++){const r=await get(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&startTime=${s}&limit=1000`);
  if(!Array.isArray(r)||!r.length)break;for(const x of r)if(+x[0]<TODAY)m.set(+x[0],{o:+x[1],c:+x[4]});s=+r.at(-1)[0]+D;await sleep(150)}return m}
async function bitfinex(sym){const m=new Map();let s=START_FETCH;for(let k=0;k<6&&s<TODAY;k++){const r=await get(`https://api-pub.bitfinex.com/v2/candles/trade:1D:${sym}/hist?start=${s}&end=${TODAY}&limit=10000&sort=1`);
  if(!Array.isArray(r)||!r.length)break;for(const x of r){const t=Math.floor(+x[0]/D)*D;if(t<TODAY)m.set(t,{o:+x[1],c:+x[2]})}s=+r.at(-1)[0]+D;await sleep(1200)}return m}
async function bitvavoEur(base){const m=new Map();for(let s=START_FETCH;s<TODAY;s+=1440*D){const r=await get(`https://api.bitvavo.com/v2/${base}-EUR/candles?interval=1d&limit=1440&start=${s}&end=${Math.min(TODAY-1,s+1440*D-1)}`);
  for(const x of r||[]){const t=+x[0];if(t<TODAY)m.set(t,{o:+x[1],c:+x[4]})}await sleep(200)}return m}
// EZB: USD und CHF je EUR
const fx={USD:new Map(),CHF:new Map()};{const txt=await get('https://data-api.ecb.europa.eu/service/data/EXR/D.USD+CHF.EUR.SP00.A?format=csvdata&startPeriod=2018-08-01','text');
  const L=txt.trim().split(/\r?\n/),h=L[0].split(','),ic=h.indexOf('CURRENCY'),it=h.indexOf('TIME_PERIOD'),iv=h.indexOf('OBS_VALUE');
  for(const l of L.slice(1)){const c=l.split(',');if(+c[iv]>0)fx[c[ic]].set(Date.parse(c[it]+'T00:00:00Z'),+c[iv])}}
const days=[];for(let t=START_FETCH;t<TODAY;t+=D)days.push(t);
const ffill=m=>{const a=[];let last=NaN;for(const t of days){if(m.has(t))last=m.get(t);a.push(last)}const f=a.find(x=>x===x);return a.map(x=>x===x?x:f)};
const usd=ffill(fx.USD),chf=ffill(fx.CHF);

const P={},quelle={},kontrolle={};
for(const c of coins){
  const src=[];let b=new Map();for(const s of (BIN[c]||[c+'USDT'])){const m=await binance(s);if(m.size){src.push(['Binance '+s,m]);b=m;break}}
  let f=new Map();for(const s of (BFX[c]||[])){const m=await bitfinex(s);if(m.size>f.size)f=m}if(f.size)src.push(['Bitfinex',f]);
  let v=new Map();try{v=await bitvavoEur(c)}catch(e){}if(v.size){const vu=new Map();for(const [t,x] of v){const i=Math.round((t-START_FETCH)/D);if(i>=0&&i<days.length)vu.set(t,{o:x.o*usd[i],c:x.c*usd[i]})}src.push(['Bitvavo EUR×EZB',vu])}
  // zusammenführen: erste Quelle hat Vorrang, Lücken aus den nächsten
  const m=new Map(),used={};for(const [n,s] of src)for(const [t,x] of s)if(!m.has(t)&&x.c>0){m.set(t,x);used[n]=(used[n]||0)+1}
  // Kontrolle: Abweichung zwischen den Quellen an gemeinsamen Tagen
  const k={};for(let a=0;a<src.length;a++)for(let z=a+1;z<src.length;z++){const d=[];for(const [t,x] of src[a][1]){const y=src[z][1].get(t);if(y&&x.c>0&&y.c>0)d.push(Math.abs(y.c/x.c-1))}
    d.sort((p,q)=>p-q);if(d.length)k[src[a][0]+' / '+src[z][0]]={tage:d.length,median_pct:+(d[d.length>>1]*100).toFixed(2)}}
  P[c]=m;quelle[c]=used;kontrolle[c]=k;console.log(c,JSON.stringify(used))}

// Reihen je Coin
const A={};for(const c of coins){const m=P[c],o=[],cl=[];for(const t of days){const x=m.get(t);o.push(x?x.o:NaN);cl.push(x?x.c:NaN)}
  const sma=N=>{const a=new Array(days.length).fill(NaN);for(let i=N-1;i<days.length;i++){let s=0,ok=true;for(let j=i-N+1;j<=i;j++){if(!(cl[j]>0)){ok=false;break}s+=cl[j]}if(ok)a[i]=s/N}return a};
  A[c]={o,c:cl,sma:{40:sma(40),50:sma(50),60:sma(60)}}}

const BITVAVO_USDC=new Set(['BTC','ETH','XRP','SOL','ADA']);   // heute gegen USDC mit > 50k $/Tag handelbar
function sim({name,N=50,freq='taeglich',wd=1,cost=0.001,reserve=0.05,band=0.05,filter=true,universe=null,start,w=null}){
  const i0=days.findIndex(t=>t>=start);w=w??(1-reserve)/5;
  let cash=1000*usd[i0]*(1-0.001),fees=1000*usd[i0]*0.001,trades=0,hold={},lueckeTage=0;const eq=[];
  for(let i=i0;i<days.length;i++){
    const decide=i>i0&&(freq==='taeglich'||new Date(days[i-1]).getUTCDay()===wd||i-1===i0);
    if(decide){const j=i-1;let top=topAt(days[j]);if(universe)top=top.filter(c=>universe.has(c));top=top.slice(0,5);
      const want=new Set(top.filter(c=>A[c]&&A[c].c[j]>0&&(!filter||A[c].c[j]>A[c].sma[N][j])));
      lueckeTage+=top.filter(c=>!(A[c]&&A[c].c[j]>0)).length;
      const px=c=>A[c].o[i]>0?A[c].o[i]:A[c].c[i-1];
      let val=cash;for(const [c,q] of Object.entries(hold))val+=q*px(c);
      for(const c of Object.keys(hold))if(!want.has(c)){const v=hold[c]*px(c),f=v*cost;cash+=v-f;fees+=f;trades++;delete hold[c]}
      for(const c of want){const cur=(hold[c]||0)*px(c),tgt=val*w,diff=tgt-cur;if(!(px(c)>0))continue;
        if(!hold[c]||Math.abs(diff)/val>band){if(diff>0){const amt=Math.min(diff,cash);if(amt<5)continue;const f=amt*cost;hold[c]=(hold[c]||0)+(amt-f)/px(c);cash-=amt;fees+=f;trades++}
          else{const q=-diff/px(c),f=-diff*cost;hold[c]-=q;cash+=-diff-f;fees+=f;trades++}}}}
    let v=cash;for(const [c,q] of Object.entries(hold)){const p=A[c].c[i]>0?A[c].c[i]:(A[c].o[i]>0?A[c].o[i]:NaN);v+=q*(p===p?p:0)}
    eq.push(v)}
  const yrs=(days.length-1-i0)/365;
  const kenn=(e,s0)=>{let pk=e[0],dd=0;for(const v of e){pk=Math.max(pk,v);dd=Math.min(dd,v/pk-1)}const jahr={};
    for(let k=0;k<e.length;k++){const y=new Date(days[i0+k]).getUTCFullYear();(jahr[y]||(jahr[y]={a:k?e[k-1]:s0})).e=e[k]}
    return{ende:+e.at(-1).toFixed(0),pro_jahr_pct:+((Math.pow(e.at(-1)/s0,1/yrs)-1)*100).toFixed(1),max_rueckgang_pct:+(dd*100).toFixed(1),
      letzte_12_monate_pct:+((e.at(-1)/e[e.length-366]-1)*100).toFixed(1),jahre:Object.fromEntries(Object.entries(jahr).map(([y,x])=>[y,+((x.e/x.a-1)*100).toFixed(1)]))}};
  const eE=eq.map((v,k)=>v/usd[i0+k]),eC=eE.map((v,k)=>v*chf[i0+k]);
  return{name,start:new Date(days[i0]).toISOString().slice(0,10),trades,gebuehren_usd:+fees.toFixed(0),luecken_tage:lueckeTage,
    usd:kenn(eq,1000*usd[i0]),eur:kenn(eE,1000),chf:kenn(eC,1000*chf[i0]),verlauf:eq.map((v,k)=>[new Date(days[i0+k]).toISOString().slice(0,10),+v.toFixed(0)]).filter((_,k)=>k%7===0)}}

const out={erstellt:new Date().toISOString(),regeln:'1000 € → USDC (0,10 %), 5 % Reserve, 19 % je Top-5-Coin über dem 50-Tage-Durchschnitt, Kosten 0,10 % je Trade (0,05 % Gebühr + 0,05 % Spread/Schlupf), Ausführung Eröffnungskurs Folgetag, Gewichtsband ±5 Prozentpunkte',
  coins,quelle,kontrolle,ranglisten:ranks.length,ergebnisse:{}};
for(const [lab,start] of [['ab_2019',Date.UTC(2019,0,1)],['ab_2020',Date.UTC(2020,0,1)]]){
  const R=[];
  R.push(sim({name:'Top 5, 50 Tage, täglich (Tool-Regel)',start}));
  R.push(sim({name:'Top 5, 50 Tage, wöchentlich (Montag)',freq:'woechentlich',start}));
  R.push(sim({name:'Top 5 ohne Filter (halten, Gewichte nachziehen)',filter:false,start}));
  R.push(sim({name:'Bitcoin halten',reserve:0,w:1,filter:false,universe:new Set(['BTC']),start,band:1}));
  R.push(sim({name:'Top 5, 50 Tage, täglich, nur heutige Bitvavo-USDC-Coins (Rückschau)',universe:BITVAVO_USDC,start}));
  R.push(sim({name:'Top 5, 50 Tage, täglich, Kosten wie EUR-Markt (0,30 %)',cost:0.003,start}));
  const emp=[];for(const N of [40,50,60]){emp.push({tage:N,frequenz:'täglich',...pick(sim({name:'',N,start}))});for(let wd=0;wd<7;wd++)emp.push({tage:N,frequenz:'wöchentlich '+['So','Mo','Di','Mi','Do','Fr','Sa'][wd],...pick(sim({name:'',N,freq:'w',wd,start}))})}
  out.ergebnisse[lab]={strategien:R,empfindlichkeit:emp}}
function pick(s){return{pro_jahr_chf:s.chf.pro_jahr_pct,rueckgang_chf:s.chf.max_rueckgang_pct,letzte_12m_chf:s.chf.letzte_12_monate_pct,trades:s.trades}}
fs.mkdirSync('ergebnis',{recursive:true});fs.writeFileSync('ergebnis/top5_backtest.json',JSON.stringify(out,null,1));
for(const [lab,e] of Object.entries(out.ergebnisse)){console.log('==',lab);for(const s of e.strategien)console.log(s.name.padEnd(70),'CHF',s.chf.ende,s.chf.pro_jahr_pct+'%/J','DD',s.chf.max_rueckgang_pct,'12M',s.chf.letzte_12_monate_pct,'Trades',s.trades,'Luecken',s.luecken_tage)}
// Für das Protokoll: alle Kennzahlen ohne Verlauf (Download-Pakete sind nicht überall abrufbar)
console.log('JSON-START');console.log(JSON.stringify({...out,ergebnisse:Object.fromEntries(Object.entries(out.ergebnisse).map(([k,e])=>[k,{...e,strategien:e.strategien.map(({verlauf,...s})=>({...s,verlauf_monatlich:verlauf.filter((_,i)=>i%4===0)}))}]))}));console.log('JSON-ENDE');
