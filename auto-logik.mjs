// Rechenlogik der Automatik «Top 5 mit Trendfilter 50 Tage» – ohne Netzwerk und ohne Dateien, damit sie testbar ist.
// bot.mjs holt die Daten (Kurse, Kerzen, Kontostand, CoinGecko) und ruft diese Funktionen auf.

// Strategie (unverändert)
export const AUTO={start_eur:1000,reserve:0.05,n:5,sma:50,band:0.05,minOrder:5,fee:0.0005,umtausch:0.001,operatorId:20261104};

// Unabhängige Risikoprüfung: jede Order muss diese Grenzen einhalten, sonst wird sie nicht ausgeführt
export const RISK={
  maxAnteilKauf:0.25,    // ein Kauf höchstens 25 % des Kassenbuchwerts (Verkäufe sind durch den Bestand begrenzt)
  maxOrdersTag:12,       // höchstens 12 Orders pro Tag (UTC)
  maxSpread:0.005,       // Brief/Geld − 1 höchstens 0,5 %
  maxAbweichung:0.10,    // Kurs höchstens 10 % vom letzten Tagesschluss (Kauf: blockieren; Verkauf: warnen)
  topMaxAlterTage:3,     // gespeicherte Top-5-Liste bei CoinGecko-Ausfall höchstens 3 Tage alt
};

const DAY=864e5;
export const floorDec=(q,d)=>{const f=10**d;return Math.floor(q*f*(1+1e-12))/f};
export const floor2=x=>Math.floor(x*100)/100;
export const tagUTC=t=>new Date(t).toISOString().slice(0,10);

// Rangliste: die 5 grössten Coins nach Marktkapitalisierung (CoinGecko) mit liquidem USDC-Markt.
// cgOk=false heisst: CoinGecko nicht erreichbar → gespeicherte Liste (höchstens 3 Tage alt) oder gar keine.
export function rangliste({liquid,stable=new Set(),mcap={},cgOk,vol30={},gespeichert=null,jetzt}){
  const cands=liquid.filter(b=>!stable.has(b));
  if(cgOk){
    const top=[...cands].sort((a,b)=>(mcap[b]||0)-(mcap[a]||0)||(vol30[b]||0)-(vol30[a]||0)).slice(0,AUTO.n);
    return{top,quelle:'coingecko',speichern:{liste:top,t:jetzt}};
  }
  if(gespeichert&&jetzt-gespeichert.t<=RISK.topMaxAlterTage*DAY){
    return{top:gespeichert.liste.filter(c=>cands.includes(c)),quelle:'gespeichert',alter_std:Math.round((jetzt-gespeichert.t)/36e5)};
  }
  return{top:[],quelle:'keine',fehler:'CoinGecko nicht erreichbar und keine gespeicherte Top-5-Liste der letzten 3 Tage'};
}

// Signal je Coin: letzter abgeschlossener Tagesschluss gegenüber dem 50-Tage-Durchschnitt. kerzen = [[zeit_ms, schluss], …]
export function signal(kerzen,heute,top5=false){
  const r=kerzen.filter(k=>k[0]<heute).sort((a,b)=>a[0]-b[0]);
  const cl=r.map(k=>k[1]),last=cl.at(-1),sma=cl.length>=AUTO.sma?cl.slice(-AUTO.sma).reduce((s,v)=>s+v,0)/AUTO.sma:NaN;
  return{schluss:last,sma50:sma,ueber:last>sma,abstand_pct:sma?+((last/sma-1)*100).toFixed(2):null,tag:r.length?tagUTC(r.at(-1)[0]):null,top5};
}

export const wertKassenbuch=(pos,cash,books,sig={})=>cash+Object.entries(pos).reduce((s,[c,q])=>s+q*(books[c]?.bid||sig[c]?.schluss||0),0);

// Plan des Tages, gleiche Regeln wie bisher: zuerst verkaufen (nicht mehr gewünscht oder übergewichtet),
// dann kaufen (neu oder untergewichtet), 19 % je Coin, Band 5 Punkte, Reserve 5 %, Mindestorder 5 USDC.
// Live: Mengen zusätzlich durch das echte Konto begrenzt (bal). Erlöse der Verkäufe werden geschätzt (Geldkurs − Gebühr).
export function planeOrders({pos,cash,top,sig,books,dec={},bal=null}){
  const want=new Set(top.filter(c=>sig[c]?.ueber)),w=(1-AUTO.reserve)/AUTO.n;
  const S={pos:{...pos},cash},orders=[];let balU=bal?(bal.USDC||0):Infinity;
  const V=()=>wertKassenbuch(S.pos,S.cash,books,sig);
  for(const [c,q] of Object.entries(pos)){const bk=books[c];if(!bk)continue;
    const v=V(),cur=S.pos[c]*bk.bid;let amt,grund;
    if(want.has(c)){amt=cur-v*w>v*AUTO.band?(cur-v*w)/bk.bid:0;grund='übergewichtet, auf 19 % zurück'}
    else{amt=S.pos[c];grund=!top.includes(c)?'nicht mehr in den Top 5':'unter dem 50-Tage-Durchschnitt'}
    if(bal)amt=Math.min(amt,bal[c]||0);amt=floorDec(amt,dec[c]??6);
    if(amt>0&&amt*bk.bid>=AUTO.minOrder){const erl=amt*bk.bid*(1-AUTO.fee);
      orders.push({seite:'verkauf',coin:c,markt:c+'-USDC',menge:amt,kurs:bk.bid,betrag_usdc:+(amt*bk.bid).toFixed(2),grund});
      S.pos[c]-=amt;if(S.pos[c]<1e-12)delete S.pos[c];S.cash+=erl;balU+=erl}}
  for(const c of want){const bk=books[c];if(!bk)continue;
    const v=V(),cur=(S.pos[c]||0)*bk.bid;
    if(S.pos[c]&&v*w-cur<=v*AUTO.band)continue;
    let amt=Math.min(v*w-cur,S.cash-v*AUTO.reserve);if(bal)amt=Math.min(amt,balU-0.01);amt=floor2(amt);
    if(amt>=AUTO.minOrder){
      orders.push({seite:'kauf',coin:c,markt:c+'-USDC',menge:+(amt*(1-AUTO.fee)/bk.ask).toFixed(8),kurs:bk.ask,betrag_usdc:amt,grund:S.pos[c]?'untergewichtet, auf 19 % auf':'neu über dem 50-Tage-Durchschnitt'});
      S.pos[c]=(S.pos[c]||0)+amt*(1-AUTO.fee)/bk.ask;S.cash-=amt;balU-=amt}}
  return orders;
}

// Unabhängige Prüfung einer Order. kontext:
//   top, pos (Kassenbuch), cash, wert (Kassenbuchwert), books, sig, bal (echtes Konto, nur live), ordersHeute,
//   abgleichOk (Kassenbuch = Konto), manuell (Notausstieg «auto verkaufen»: nur Markt und Menge prüfen)
// Ergebnis: {ok, grund, warnung}
export function pruefeOrder(o,k){
  const no=grund=>({ok:false,grund}),warn=[];
  const c=o.coin,bk=k.books?.[c],seite=o.seite;
  if(!c||o.markt!==c+'-USDC')return no(`Markt ${o.markt} ist kein USDC-Markt dieses Coins`);
  if(seite!=='kauf'&&seite!=='verkauf')return no('unbekannte Seite');
  if(seite==='kauf'&&!k.top?.includes(c))return no(`${c} ist heute nicht in den Top 5`);
  if(seite==='verkauf'&&!(k.pos?.[c]>0))return no(`${c} steht nicht im Kassenbuch`);
  if(seite==='verkauf'){
    if(!(o.menge>0))return no('Menge fehlt');
    if(o.menge>(k.pos[c]||0)*(1+1e-9))return no(`Verkauf von ${o.menge} ${c}, im Kassenbuch nur ${k.pos[c]}`);
    if(k.bal&&o.menge>(k.bal[c]||0)*(1+1e-9))return no(`Verkauf von ${o.menge} ${c}, auf dem Konto nur ${k.bal[c]||0}`);
  }
  if(!bk||!(bk.bid>0)||!(bk.ask>0))return no('kein Kurs im Orderbuch');
  const spread=bk.ask/bk.bid-1;
  if(k.manuell){   // Notausstieg: nur Markt und Menge, sonst nur warnen
    if(spread>RISK.maxSpread)warn.push(`Spread ${(spread*100).toFixed(2)} % ist hoch`);
    return{ok:true,grund:null,warnung:warn.join('; ')||null};
  }
  if((k.ordersHeute||0)>=RISK.maxOrdersTag)return no(`Tageslimit von ${RISK.maxOrdersTag} Orders erreicht`);
  if(spread>RISK.maxSpread)return no(`Spread ${(spread*100).toFixed(2)} % über ${RISK.maxSpread*100} %`);
  const schluss=k.sig?.[c]?.schluss,px=seite==='kauf'?bk.ask:bk.bid;
  const abw=schluss>0?Math.abs(px/schluss-1):null;
  if(seite==='kauf'){
    if(abw==null)return no('kein Tagesschluss zum Vergleich');
    if(abw>RISK.maxAbweichung)return no(`Kurs ${(abw*100).toFixed(1)} % vom letzten Tagesschluss entfernt`);
    if(k.abgleichOk===false)return no('Kontoabgleich stimmt nicht – keine Käufe, bis er wieder stimmt');
    if(o.betrag_usdc>k.wert*RISK.maxAnteilKauf+0.005)return no(`Betrag ${o.betrag_usdc.toFixed(2)} USDC über ${RISK.maxAnteilKauf*100} % des Kassenbuchwerts`);
    if(k.cash-o.betrag_usdc<k.wert*AUTO.reserve-0.01)return no(`Reserve von ${AUTO.reserve*100} % würde unterschritten`);
    if(k.bal&&o.betrag_usdc>(k.bal.USDC||0))return no(`nur ${(k.bal.USDC||0).toFixed(2)} USDC auf dem Konto`);
  }else if(abw!=null&&abw>RISK.maxAbweichung)warn.push(`Kurs ${(abw*100).toFixed(1)} % vom letzten Tagesschluss entfernt – Verkauf trotzdem ausgeführt`);
  return{ok:true,grund:null,warnung:warn.join('; ')||null};
}

// Kassenbuch gegen Konto (nur live): auf dem Konto muss mindestens so viel liegen wie im Kassenbuch
export function abgleichen(pos,cash,bal){
  const zeilen=Object.fromEntries(Object.entries(pos).map(([c,q])=>[c,{kassenbuch:+q.toFixed(8),konto:bal[c]||0,ok:(bal[c]||0)>=q*0.999}]));
  zeilen.USDC={kassenbuch:+cash.toFixed(2),konto:bal.USDC||0,ok:(bal.USDC||0)>=cash*0.999-0.05};
  return{zeilen,ok:Object.values(zeilen).every(x=>x.ok)};
}

// Bestätigungsmodus: was mit einem wartenden Plan geschieht
export function planStatus(plan,jetzt,ja){
  if(!plan||plan.status!=='wartet')return'kein';
  if(jetzt>plan.gueltig_bis)return'verfallen';
  return ja?'ausfuehren':'wartet';
}
export const endeTagUTC=t=>Math.floor(t/DAY)*DAY+DAY-1;

export function planText(orders){
  if(!orders.length)return'Keine Orders.';
  return orders.map(o=>`${o.pruefung?.ok===false?'⛔ ':''}${o.seite==='kauf'?'Kauf':'Verkauf'} ${o.coin} ${o.betrag_usdc.toFixed(2)} USDC${o.pruefung?.ok===false?` (${o.pruefung.grund})`:''}`).join(' · ');
}
