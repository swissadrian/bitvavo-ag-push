// Tests der Automatik-Logik mit festen Testdaten. Start: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {AUTO,RISK,rangliste,signal,planeOrders,pruefeOrder,abgleichen,planStatus,endeTagUTC,wertKassenbuch,floorDec,floor2} from '../auto-logik.mjs';

const D=864e5,HEUTE=Date.UTC(2026,10,15),JETZT=HEUTE+5*60e3;
// 60 Tageskerzen bis gestern: gleichmässig steigend (über dem Ø50) oder fallend (unter dem Ø50)
const kerzen=(start,schritt)=>Array.from({length:60},(_,i)=>[HEUTE-(60-i)*D,start+schritt*i]);
const book=(px,spread=0.0004)=>({bid:px,ask:px*(1+spread)});
const STABLE=new Set(['USDC','USDT']);

function lage({pos={},cash=1000,trend={BTC:1,ETH:1,XRP:1,SOL:1,ADA:1},preis={BTC:80000,ETH:3000,XRP:1.2,SOL:100,ADA:0.5}}={}){
  const top=Object.keys(trend),sig={},books={};
  for(const c of new Set([...top,...Object.keys(pos)])){const p=preis[c];const k=trend[c]>=0?kerzen(p*0.8,p*0.2/59):kerzen(p*1.2,-p*0.2/59);
    sig[c]=signal(k,HEUTE,top.includes(c));books[c]=book(sig[c].schluss)}
  return{pos,cash,top,sig,books};
}
const kontext=(L,extra={})=>({top:L.top,pos:L.pos,cash:L.cash,wert:wertKassenbuch(L.pos,L.cash,L.books,L.sig),books:L.books,sig:L.sig,bal:null,ordersHeute:0,abgleichOk:true,...extra});

test('Signal: Schluss über bzw. unter dem 50-Tage-Durchschnitt, nur abgeschlossene Tage',()=>{
  const k=[...kerzen(100,1),[HEUTE,1]];   // Kerze von heute (unfertig) wird ignoriert
  const s=signal(k,HEUTE);assert.equal(s.schluss,159);assert.equal(s.ueber,true);
  assert.equal(signal(kerzen(100,-1),HEUTE).ueber,false);
  assert.ok(Number.isNaN(signal(kerzen(100,1).slice(-20),HEUTE).sma50),'weniger als 50 Tage: kein Durchschnitt');
});

test('Start aus 100 % USDC: 5 Käufe zu je 19 %, 5 % Reserve bleibt',()=>{
  const L=lage();const o=planeOrders(L);
  assert.equal(o.length,5);assert.ok(o.every(x=>x.seite==='kauf'));
  // je 19 % des Werts; der Wert sinkt nach jedem Kauf leicht um Gebühr und Spread
  for(const x of o)assert.ok(Math.abs(x.betrag_usdc-190)<0.5,`${x.coin} ${x.betrag_usdc}`);
  const rest=1000-o.reduce((s,x)=>s+x.betrag_usdc,0);assert.ok(rest>=50-0.05,`Reserve ${rest}`);
});

test('Neuer Coin in den Top 5: wird gekauft, Prüfung ok',()=>{
  const L=lage({trend:{BTC:1,ETH:1,XRP:1,SOL:1,DOGE:1},preis:{BTC:80000,ETH:3000,XRP:1.2,SOL:100,DOGE:0.2},cash:200,
    pos:{BTC:0.002375,ETH:0.06333,XRP:158.33,SOL:1.9}});
  const o=planeOrders(L);const doge=o.find(x=>x.coin==='DOGE');
  assert.ok(doge&&doge.seite==='kauf',JSON.stringify(o));
  assert.equal(doge.grund,'neu über dem 50-Tage-Durchschnitt');
  assert.ok(pruefeOrder(doge,kontext(L)).ok);
});

test('Coin fällt unter den 50-Tage-Durchschnitt: ganze Position wird verkauft',()=>{
  const L=lage({trend:{BTC:-1,ETH:1,XRP:1,SOL:1,ADA:1},cash:50,pos:{BTC:0.002375,ETH:0.0633,XRP:158.3,SOL:1.9,ADA:380}});
  const o=planeOrders(L);const btc=o.find(x=>x.coin==='BTC');
  assert.equal(btc.seite,'verkauf');assert.equal(btc.menge,0.002375);assert.equal(btc.grund,'unter dem 50-Tage-Durchschnitt');
  assert.ok(pruefeOrder(btc,kontext(L)).ok);
  assert.ok(!o.some(x=>x.coin==='BTC'&&x.seite==='kauf'));
});

test('Coin fällt aus den Top 5: wird verkauft',()=>{
  const L=lage({trend:{BTC:1,ETH:1,XRP:1,SOL:1,ADA:1},cash:50,pos:{DOGE:500},preis:{BTC:80000,ETH:3000,XRP:1.2,SOL:100,ADA:0.5,DOGE:0.2}});
  L.sig.DOGE=signal(kerzen(0.16,0.04/59),HEUTE,false);L.books.DOGE=book(L.sig.DOGE.schluss);
  const o=planeOrders(L);assert.equal(o.find(x=>x.coin==='DOGE').grund,'nicht mehr in den Top 5');
});

test('Gewicht weicht mehr als 5 Punkte ab: wird nachgezogen, bei 4 Punkten nicht',()=>{
  // BTC hat 25 % statt 19 % → Teilverkauf auf 19 %
  const p=80000,L=lage({cash:50,pos:{BTC:250/p,ETH:175/3000,XRP:175/1.2,SOL:175/100,ADA:175/0.5}});
  const V=wertKassenbuch(L.pos,L.cash,L.books,L.sig);
  const o=planeOrders(L);const btc=o.find(x=>x.coin==='BTC');
  assert.ok(btc&&btc.seite==='verkauf',JSON.stringify(o));
  assert.ok(Math.abs((250-btc.betrag_usdc)/V-0.19)<0.002,`danach ${((250-btc.betrag_usdc)/V*100).toFixed(2)} %`);
  // BTC hat 23 % (4 Punkte drüber) → nichts
  const L2=lage({cash:50,pos:{BTC:230/p,ETH:180/3000,XRP:180/1.2,SOL:180/100,ADA:180/0.5}});
  assert.ok(!planeOrders(L2).some(x=>x.coin==='BTC'));
});

test('Untergewicht über 5 Punkte wird aufgefüllt, innerhalb des Bands nicht',()=>{
  const L=lage({cash:300,pos:{BTC:100/80000,ETH:190/3000,XRP:190/1.2,SOL:190/100,ADA:30/0.5}});
  const o=planeOrders(L);
  assert.ok(o.some(x=>x.coin==='BTC'&&x.seite==='kauf'));
  assert.ok(!o.some(x=>x.coin==='ETH'));
});

test('CoinGecko liefert Daten: Rangliste nach Marktkapitalisierung, wird gespeichert',()=>{
  const r=rangliste({liquid:['ADA','BTC','ETH','XRP','SOL','USDT','DOGE'],stable:STABLE,mcap:{BTC:5,ETH:4,XRP:3,SOL:2,ADA:1,DOGE:0.5,USDT:9},cgOk:true,jetzt:JETZT});
  assert.deepEqual(r.top,['BTC','ETH','XRP','SOL','ADA']);assert.equal(r.quelle,'coingecko');assert.deepEqual(r.speichern.liste,r.top);
});

test('CoinGecko fällt aus, gespeicherte Liste höchstens 3 Tage alt: wird verwendet (ohne illiquide Coins)',()=>{
  const r=rangliste({liquid:['BTC','ETH','XRP','SOL'],cgOk:false,gespeichert:{liste:['BTC','ETH','XRP','SOL','ADA'],t:JETZT-2*D},jetzt:JETZT});
  assert.equal(r.quelle,'gespeichert');assert.deepEqual(r.top,['BTC','ETH','XRP','SOL']);
});

test('CoinGecko fällt aus, keine gültige Liste: kein Handel (nicht nach Umsatz sortieren)',()=>{
  const alt=rangliste({liquid:['BTC','ETH'],cgOk:false,gespeichert:{liste:['BTC','ETH'],t:JETZT-4*D},vol30:{ETH:9,BTC:1},jetzt:JETZT});
  assert.equal(alt.quelle,'keine');assert.deepEqual(alt.top,[]);assert.ok(alt.fehler);
  assert.equal(rangliste({liquid:['BTC'],cgOk:false,gespeichert:null,jetzt:JETZT}).quelle,'keine');
});

test('Spread zu gross: Kauf und Verkauf werden blockiert',()=>{
  const L=lage({pos:{BTC:0.001}});L.books.BTC=book(80000,0.006);
  const k=pruefeOrder({seite:'kauf',coin:'BTC',markt:'BTC-USDC',betrag_usdc:100,menge:0.001,kurs:80480},kontext(L));
  assert.equal(k.ok,false);assert.match(k.grund,/Spread/);
  const v=pruefeOrder({seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.001,betrag_usdc:80,kurs:80000},kontext(L));
  assert.equal(v.ok,false);assert.match(v.grund,/Spread/);
});

test('Kontoabgleich stimmt nicht: Käufe blockiert, Verkäufe erlaubt',()=>{
  const a=abgleichen({BTC:0.01},500,{BTC:0.005,USDC:500});assert.equal(a.ok,false);assert.equal(a.zeilen.BTC.ok,false);
  assert.equal(abgleichen({BTC:0.01},500,{BTC:0.01,USDC:500.2,EUR:3}).ok,true);
  const L=lage({pos:{BTC:0.001}});
  const k=pruefeOrder({seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:100,menge:0.03,kurs:3000},kontext(L,{abgleichOk:false}));
  assert.equal(k.ok,false);assert.match(k.grund,/Kontoabgleich/);
  assert.equal(pruefeOrder({seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.001,betrag_usdc:80,kurs:80000},kontext(L,{abgleichOk:false})).ok,true);
});

test('Mehr als 12 Orders am Tag: die 13. wird blockiert',()=>{
  const L=lage();const o={seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:100,menge:0.03,kurs:3000};
  assert.equal(pruefeOrder(o,kontext(L,{ordersHeute:11})).ok,true);
  const r=pruefeOrder(o,kontext(L,{ordersHeute:12}));assert.equal(r.ok,false);assert.match(r.grund,/Tageslimit/);
});

test('Kauf über 25 % des Kassenbuchwerts wird blockiert',()=>{
  const L=lage();const r=pruefeOrder({seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:260,menge:0.08,kurs:3000},kontext(L));
  assert.equal(r.ok,false);assert.match(r.grund,/25 %/);
});

test('Reserve von 5 % wird nie unterschritten',()=>{
  const L=lage({cash:200,pos:{BTC:800/80000}});
  const r=pruefeOrder({seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:160,menge:0.05,kurs:3000},kontext(L));
  assert.equal(r.ok,false);assert.match(r.grund,/Reserve/);
  assert.equal(pruefeOrder({seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:150,menge:0.05,kurs:3000},kontext(L)).ok,true);
});

test('Verkauf von mehr als im Kassenbuch oder auf dem Konto: blockiert',()=>{
  const L=lage({pos:{BTC:0.001}});const o={seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.002,betrag_usdc:160,kurs:80000};
  assert.match(pruefeOrder(o,kontext(L)).grund,/Kassenbuch nur/);
  assert.match(pruefeOrder({...o,menge:0.001},kontext(L,{bal:{BTC:0.0005,USDC:0}})).grund,/Konto nur/);
});

test('Nur USDC-Märkte und nur Top-5- bzw. Kassenbuch-Coins',()=>{
  const L=lage({pos:{BTC:0.001}});
  assert.match(pruefeOrder({seite:'kauf',coin:'BTC',markt:'BTC-EUR',betrag_usdc:50,menge:1,kurs:1},kontext(L)).grund,/USDC-Markt/);
  assert.match(pruefeOrder({seite:'kauf',coin:'DOGE',markt:'DOGE-USDC',betrag_usdc:50,menge:1,kurs:1},kontext(L)).grund,/nicht in den Top 5/);
  assert.match(pruefeOrder({seite:'verkauf',coin:'ETH',markt:'ETH-USDC',menge:1,betrag_usdc:50,kurs:1},kontext(L)).grund,/nicht im Kassenbuch/);
});

test('Kurs über 10 % vom Tagesschluss: Kauf blockiert, Verkauf mit Warnung ausgeführt',()=>{
  const L=lage({pos:{BTC:0.001}});L.books.ETH=book(L.sig.ETH.schluss*1.12);L.books.BTC=book(L.sig.BTC.schluss*0.85);
  const k=pruefeOrder({seite:'kauf',coin:'ETH',markt:'ETH-USDC',betrag_usdc:100,menge:0.03,kurs:3000},kontext(L));
  assert.equal(k.ok,false);assert.match(k.grund,/Tagesschluss/);
  const v=pruefeOrder({seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.001,betrag_usdc:68,kurs:68000},kontext(L));
  assert.equal(v.ok,true);assert.match(v.warnung,/Tagesschluss/);
});

test('Notausstieg («auto verkaufen»): nur Markt und Menge, Spread und Tageslimit nur als Warnung',()=>{
  const L=lage({pos:{BTC:0.001}});L.books.BTC=book(80000,0.02);
  const r=pruefeOrder({seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.001,betrag_usdc:80,kurs:80000},{pos:L.pos,books:L.books,ordersHeute:99,manuell:true});
  assert.equal(r.ok,true);assert.match(r.warnung,/Spread/);
  assert.equal(pruefeOrder({seite:'verkauf',coin:'BTC',markt:'BTC-USDC',menge:0.002,betrag_usdc:160,kurs:80000},{pos:L.pos,books:L.books,manuell:true}).ok,false);
});

test('Bestätigungsmodus: wartet, wird mit «ja» ausgeführt, verfällt um 23:59 UTC',()=>{
  const plan={status:'wartet',gueltig_bis:endeTagUTC(JETZT)};
  assert.equal(planStatus(plan,JETZT,false),'wartet');
  assert.equal(planStatus(plan,JETZT+3600e3,true),'ausfuehren');
  assert.equal(planStatus(plan,HEUTE+D,true),'verfallen');
  assert.equal(planStatus({status:'ausgeführt'},JETZT,true),'kein');
  assert.equal(new Date(endeTagUTC(JETZT)).toISOString(),'2026-11-15T23:59:59.999Z');
});

// Bisherige Logik aus bot.mjs (Papier-Modus) als Vergleich: die neue Planung muss dieselben Orders ergeben
function alteLogik({pos,cash,top,sig,books}){
  const B={pos:{...pos},cash},rows=[],fee=AUTO.fee;
  const value=()=>B.cash+Object.entries(B.pos).reduce((s,[c,q])=>s+q*(books[c]?.bid||sig[c]?.schluss||0),0);
  const want=new Set(top.filter(c=>sig[c]?.ueber)),w=(1-AUTO.reserve)/AUTO.n;
  for(const [c,q] of Object.entries({...B.pos})){const bk=books[c];if(!bk)continue;const V=value(),cur=q*bk.bid;
    let amt=want.has(c)?(cur-V*w>V*AUTO.band?(cur-V*w)/bk.bid:0):q;amt=floorDec(amt,6);
    if(amt>0&&amt*bk.bid>=AUTO.minOrder){const v=amt*bk.bid;B.pos[c]-=amt;if(B.pos[c]<1e-12)delete B.pos[c];B.cash+=v-v*fee;rows.push(['verkauf',c,amt])}}
  for(const c of want){const bk=books[c];if(!bk)continue;const V=value(),cur=(B.pos[c]||0)*bk.bid;
    if(B.pos[c]&&V*w-cur<=V*AUTO.band)continue;
    let amt=Math.min(V*w-cur,B.cash-V*AUTO.reserve);amt=Math.floor(amt*100)/100;
    if(amt>=AUTO.minOrder){B.pos[c]=(B.pos[c]||0)+amt*(1-fee)/bk.ask;B.cash-=amt;rows.push(['kauf',c,amt])}}
  return rows;
}
test('Strategie unverändert: gleiche Orders wie die bisherige Logik (200 Zufallslagen)',()=>{
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const coins=['BTC','ETH','XRP','SOL','ADA','DOGE'],preis={BTC:80000,ETH:3000,XRP:1.2,SOL:100,ADA:0.5,DOGE:0.2};
  for(let n=0;n<200;n++){
    const trend={};for(const c of coins.slice(0,5+Math.round(rnd())).slice(-5))trend[c]=rnd()<0.6?1:-1;
    const pos={};for(const c of coins)if(rnd()<0.5)pos[c]=+(rnd()*300/preis[c]).toFixed(6);
    const L=lage({trend,preis,pos,cash:+(rnd()*600).toFixed(2)});
    for(const c of Object.keys(pos))if(!L.sig[c]){L.sig[c]=signal(kerzen(preis[c]*0.8,preis[c]*0.2/59),HEUTE,false);L.books[c]=book(L.sig[c].schluss)}
    const neu=planeOrders(L).map(o=>[o.seite,o.coin,o.seite==='kauf'?o.betrag_usdc:o.menge]);
    assert.deepEqual(neu,alteLogik(L),`Lage ${n}`);
  }
});
