import { validQuoteRut, type QuoteParty } from './crm-quote.ts';
export type QuoteFlowMessage={direction:string;body:string;status:string;occurredAt:string};
const normal=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export const wantsFormalQuote=(body:string)=>/\b(?:cotizacion\s+formal|cotizar\s+formal|presupuesto\s+formal|pdf)\b/.test(normal(body))&&!/\b(?:no quiero|cancelar|cancela)\b/.test(normal(body));
export function currentQuoteSession(messages:QuoteFlowMessage[]) {
 const ordered=[...messages].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
 const last=Date.parse(ordered.at(-1)?.occurredAt||'');
 let start=0;for(let i=0;i<ordered.length;i++){const m=ordered[i];if(m.direction==='inbound'&&/^(hola|buenas|buenos dias|buenas tardes|buenas noches)(?: como (?:estas|estan)| que tal)?$/.test(normal(m.body).replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim()))start=i;}
 return ordered.slice(start).filter(m=>Date.parse(m.occurredAt)>=last-86400000);
}
export function customerFromQuoteMessages(messages:QuoteFlowMessage[]):QuoteParty {
 const customer:QuoteParty={name:'',rut:'',address:'',commune:''};
 for(const m of messages){if(m.direction!=='inbound')continue;
  const rut=m.body.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);if(rut)customer.rut=rut[0];
  const labels:[keyof QuoteParty,string][]=[['name','nombre(?: o raz[oó]n social)?|raz[oó]n social'],['address','direcci[oó]n'],['commune','comuna']];
  for(const [key,label] of labels){const match=m.body.match(new RegExp('(?:^|[\\n;,]|\\s)(?:'+label+')\\s*:\\s*(.+?)(?=\\s+(?:rut|nombre|raz[oó]n social|direcci[oó]n|comuna)\\s*:|[\\n;]|$)','i'));if(match)customer[key]=match[1].trim().replace(/[.,]+$/,'');}
  if(rut){const fields=m.body.slice((rut.index||0)+rut[0].length).trim().replace(/^[,;\s]+/,'').split(/[.\n,]+/).map(p=>p.trim()).filter(Boolean);
   if(fields.length===3&&!fields.some(p=>/^(?:nombre|raz[oó]n social|direcci[oó]n|comuna)\s*:/i.test(p))){[customer.name,customer.address,customer.commune]=fields;}
  }
 }
 return customer;
}
export function quoteCustomerMissing(customer:QuoteParty) {
 return [!customer.name?'nombre o razón social':'',!validQuoteRut(customer.rut)?'RUT válido':'',!customer.address?'dirección':'',!customer.commune?'comuna':''].filter(Boolean);
}
