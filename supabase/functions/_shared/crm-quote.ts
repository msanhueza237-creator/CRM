export type QuoteBankDetails = { bank: string; accountType: string; accountNumber: string; holder: string; rut: string; email: string };
export function latinChileQuoteBank(issuer: {rut:string}): QuoteBankDetails | undefined {
 if(issuer.rut.replace(/[.\s-]/g,'')!=='777243829')return undefined;
 return {bank:'Scotiabank',accountType:'Cuenta corriente',accountNumber:'985659206',holder:'Importadora Latin Chile Limitada',rut:'77.724.382-9',email:'ventas@climactiva.cl'};
}
export type QuoteParty = { name: string; rut: string; address: string; commune: string; phone?: string };
export type QuoteLine = { sku: string; name: string; quantity: number; requestedQuantity?: number; unitPrice: number; amount: number; productUrl: string };
export type CrmQuote = { kind: 'crm_quote_v1'; bankDetails?: QuoteBankDetails; quoteNumber?: number; id: string; folio: string; date: string; validDays: number; issuer: QuoteParty; customer: QuoteParty; lines: QuoteLine[]; pricesIncludeVat: boolean; net: number; vat: number; total: number; conditions: string; sourceMessageId: string; verifiedAt: string; logoDataUrl?: string };
export function validQuoteRut(value: string) {
 const rut=value.replace(/[.\s]/g,'').toUpperCase(), match=rut.match(/^(\d{7,8})-([\dK])$/);
 if(!match)return false;
 let sum=0,m=2;for(const digit of match[1].split('').reverse()){sum+=Number(digit)*m;m=m===7?2:m+1;}
 const digit=11-sum%11;return match[2]===(digit===11?'0':digit===10?'K':String(digit));
}
export function quoteParty(value: unknown): QuoteParty {
 const p=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 const field=(k:string,max:number)=>typeof p[k]==='string'?String(p[k]).trim().slice(0,max):'';
 const party={name:field('name',160),rut:field('rut',15),address:field('address',200),commune:field('commune',80)};
 const phone=field('phone',20);return phone?{...party,phone}:party;
}
// All line prices come from the backend's current Tiendanube reader. Store prices
// are explicitly reviewed as VAT inclusive/exclusive; tax is never added twice.
export function quoteTotals(lines: Pick<QuoteLine,'unitPrice'|'quantity'>[], includeVat: boolean) {
 if(!lines.length||lines.length>20)throw Error('Agrega entre 1 y 20 productos.');
 let sum=0;
 for(const l of lines){if(!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>9999||!Number.isFinite(l.unitPrice)||l.unitPrice<0)throw Error('Precio o cantidad inválidos.');sum+=Math.round(l.unitPrice*l.quantity);}
 if(!Number.isSafeInteger(sum)||sum>1e12)throw Error('El monto excede el límite permitido.');
 const net=includeVat?Math.round(sum/1.19):sum,vat=includeVat?sum-net:Math.round(net*.19);
 return {net,vat,total:net+vat};
}

export function quotePendingFields(quote: Pick<CrmQuote,'issuer'|'customer'>): string[] {
 const pending:string[]=[];
 for(const [label,party] of [['Emisor',quote.issuer],['Cliente',quote.customer]] as const){
  for(const [key,title] of [['name','nombre'],['rut','RUT'],['address','dirección'],['commune','comuna']] as const){
   if(!party[key]?.trim())pending.push(`${label}: ${title} pendiente`);
   else if(key==='rut'&&!validQuoteRut(party.rut))pending.push(`${label}: RUT por verificar`);
  }
 }
 return pending;
}
