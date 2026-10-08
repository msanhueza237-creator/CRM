import { quotePendingFields } from '../../supabase/functions/_shared/crm-quote';
import type { CrmQuote } from '../../supabase/functions/_shared/crm-quote';
export async function crmQuotePdf(quote: CrmQuote): Promise<File> {
 const {jsPDF}=await import('jspdf');const doc=new jsPDF();let y=20;
 const money=(v:number)=>'$'+v.toLocaleString('es-CL')+' CLP';
 const line=(text:string,size=10)=>{doc.setFontSize(size);const parts=doc.splitTextToSize(text,174);for(const p of parts){if(y>270){doc.addPage();y=20;}doc.text(p,18,y);y+=size*.45+2;}};
 if(quote.logoDataUrl){doc.addImage(quote.logoDataUrl,quote.logoDataUrl.startsWith('data:image/png')?'PNG':'JPEG',18,12,38,16,undefined,'FAST');y=36;}
 doc.setTextColor(9,93,101);line('COTIZACIÓN COMERCIAL',18);doc.setTextColor(24,49,57);
 line(quote.issuer.name||'Emisor: nombre pendiente',13);line(`RUT ${quote.issuer.rut||'pendiente'} · ${quote.issuer.address||'Dirección pendiente'}, ${quote.issuer.commune||'Comuna pendiente'}`);
 line(`Folio ${quote.folio}`,8);line(`Fecha: ${new Date(quote.date).toLocaleDateString('es-CL',{timeZone:'America/Santiago'})} · Vigencia: ${quote.validDays} días`);y+=5;
 const pending=quotePendingFields(quote);if(pending.length){line('DATOS PENDIENTES DE COMPLETAR O VERIFICAR',11);for(const note of pending)line(note,9);y+=4;}
 line('CLIENTE',12);line(`${quote.customer.name||'Nombre pendiente'} · RUT ${quote.customer.rut||'pendiente'}`);line(`${quote.customer.address||'Dirección pendiente'}, ${quote.customer.commune||'Comuna pendiente'}`);y+=5;
 for(const [i,item] of quote.lines.entries()){
  line(`${i+1}. ${item.name}`,11);line(`Código: ${item.sku} · Cantidad: ${item.quantity}`);
  const unitNet=quote.pricesIncludeVat?item.unitPrice/1.19:item.unitPrice;
  line(`Precio unitario neto: $${unitNet.toLocaleString('es-CL',{minimumFractionDigits:2,maximumFractionDigits:2})} CLP`);
  line(`Precio unitario ${quote.pricesIncludeVat?'con IVA':'neto'}: ${money(item.unitPrice)} · Importe: ${money(item.amount)}`);y+=4;
 }
 line(`Neto: ${money(quote.net)}`,12);line(`IVA 19%: ${money(quote.vat)}`,12);line(`TOTAL: ${money(quote.total)}`,14);y+=6;
 if(quote.conditions){line('CONDICIONES',11);line(quote.conditions);}
 line('Cotización comercial del CRM. No es un documento tributario ni una cotización emitida por Facto.',9);
 line('Precios y stock consultados en Tiendanube al preparar el documento. No reserva inventario ni confirma pago.',9);
 return new File([doc.output('arraybuffer')],`Cotizacion-${quote.folio}.pdf`,{type:'application/pdf'});
}
