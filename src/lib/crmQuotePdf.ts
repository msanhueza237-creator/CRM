import { quotePendingFields } from '../../supabase/functions/_shared/crm-quote';
import type { CrmQuote } from '../../supabase/functions/_shared/crm-quote';

export async function crmQuotePdf(quote: CrmQuote): Promise<File> {
 const {jsPDF}=await import('jspdf');const doc=new jsPDF();
 const left=12,right=198,width=right-left;
 const money=(v:number,decimals=0)=>'$'+v.toLocaleString('es-CL',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
 const wrap=(text:string,w:number,size=9)=>{doc.setFontSize(size);return doc.splitTextToSize(text,w) as string[];};
 const text=(value:string,x:number,y:number,size=9,bold=false)=>{doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(25,45,53);doc.text(value,x,y);};
 const box=(x:number,y:number,w:number,h:number)=>{doc.setDrawColor(95,151,165);doc.setLineWidth(.25);doc.rect(x,y,w,h);};
 const header=()=>{
  let issuerX=left;
  if(quote.logoDataUrl){doc.addImage(quote.logoDataUrl,quote.logoDataUrl.startsWith('data:image/png')?'PNG':'JPEG',left,13,35,16,undefined,'FAST');issuerX=50;}
  const issuerLines=wrap(quote.issuer.name||'Emisor: nombre pendiente',126-issuerX,11);
  issuerLines.forEach((v,i)=>text(v,issuerX,17+i*4.5,11,true));
  let issuerY=19+issuerLines.length*4.5;
  for(const value of [quote.issuer.address||'Dirección pendiente',quote.issuer.commune||'Comuna pendiente']){
   for(const v of wrap(value,126-issuerX,8)){text(v,issuerX,issuerY,8);issuerY+=3.5;}
  }
  doc.setDrawColor(175,45,45);doc.setLineWidth(.6);doc.rect(130,12,68,28);
  doc.setFont('helvetica','bold');doc.setFontSize(9);doc.setTextColor(175,45,45);doc.text(`RUT: ${quote.issuer.rut||'pendiente'}`,164,18,{align:'center'});
  doc.setFontSize(9);doc.text('COTIZACIÓN COMERCIAL',164,23,{align:'center'});
  const numberLines=wrap('N° '+(quote.quoteNumber??quote.folio),62,quote.quoteNumber?13:7);
  numberLines.forEach((v,i)=>doc.text(v,164,28+i*3,{align:'center'}));
  return Math.max(45,issuerY+4);
 };
 let y=header();
 // Reposition issuer RUT to keep long values inside the identification box.
 // Customer fields use only supplied data; missing values remain explicit.
 const customerRows=[['Señor(es)',quote.customer.name||'Nombre pendiente'],['RUT',quote.customer.rut||'pendiente'],['Dirección',quote.customer.address||'Dirección pendiente'],['Comuna',quote.customer.commune||'Comuna pendiente']];
 const customerHeight=customerRows.reduce((n,[_label,value])=>n+Math.max(5,wrap(value,102,9).length*4),4);
 box(left,y,width,customerHeight);
 let cy=y+5;
 customerRows.forEach(([label,value])=>{text(label,left+2,cy,9,true);const parts=wrap(value,102,9);parts.forEach((v,i)=>text(v,left+25,cy+i*4));cy+=Math.max(5,parts.length*4);});
 const date=new Date(quote.date).toLocaleDateString('es-CL',{timeZone:'America/Santiago'});
 text('Fecha',144,y+5,8,true);text(date,164,y+5,8);
 text('Vigencia',144,y+11,8,true);text(`${quote.validDays} días`,164,y+11,8);
 text('Moneda',144,y+17,8,true);text('CLP',164,y+17,8);
 y+=customerHeight+3;
 const cols=[12,94,109,143,158,198];
 const tableHeader=()=>{
  doc.setFillColor(28,133,170);doc.rect(left,y,width,8,'F');doc.setFont('helvetica','bold');doc.setFontSize(8);doc.setTextColor(255,255,255);
  for(const [i,title] of ['Producto / código','Cant.','P. unit. neto','IVA','Monto neto'].entries())doc.text(title,cols[i]+2,y+5);
  y+=8;
 };
 tableHeader();let tableStart=y;
 for(const item of quote.lines){
  const description=wrap(item.name+'\nCódigo: '+item.sku,78,9),rowHeight=Math.max(12,description.length*4+4);
  if(y+rowHeight>244){box(left,tableStart,width,y-tableStart);doc.addPage();y=header();tableHeader();tableStart=y;}
  description.forEach((v,i)=>text(v,left+2,y+5+i*4));
  const netUnit=quote.pricesIncludeVat?item.unitPrice/1.19:item.unitPrice;
  doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(25,45,53);doc.text(String(item.quantity),cols[2]-2,y+5,{align:'right'});
  doc.setFillColor(255,255,255); // numeric columns share right alignment
  doc.setFontSize(8);
  doc.text(money(netUnit,2),cols[3]-2,y+5,{align:'right'});
  doc.text('19%',cols[4]-2,y+5,{align:'right'});
  doc.text(money(quote.pricesIncludeVat?item.amount/1.19:item.amount,2),right-2,y+5,{align:'right'});
  y+=rowHeight;doc.setDrawColor(190,212,216);doc.line(left,y,right,y);
 }
 const bodyBottom=Math.max(y,180);box(left,tableStart,width,bodyBottom-tableStart);
 for(const x of cols.slice(1,-1))doc.line(x,tableStart-8,x,bodyBottom);
 y=bodyBottom+3;
 if(y>216){doc.addPage();y=header();}
 const pending=quotePendingFields(quote);
 const notes=[quote.conditions,...(pending.length?['Datos pendientes: '+pending.join('; ')]:[]),'Precios publicados en Tiendanube. Neto calculado sin IVA; importes del documento redondeados a pesos.'].filter(Boolean).join('\n');
 const noteLines=wrap(notes,116,8);const notesHeight=Math.max(32,noteLines.length*3.6+10);
 // Long conditions continue below the totals rather than overlap them.
 const firstNotes=noteLines.slice(0,8);box(left,y,122,40);text('Observaciones',left+2,y+5,9,true);firstNotes.forEach((v,i)=>text(v,left+2,y+10+i*3.5,8));
 box(137,y,61,40);
 for(const [i,[label,value]] of [['Monto neto',quote.net],['IVA 19%',quote.vat],['Total CLP',quote.total]].entries()){
  text(label as string,139,y+8+i*11,10,i===2);doc.text(money(value as number),196,y+8+i*11,{align:'right'});
 }
 y+=44;
 if(notesHeight>40)for(const v of noteLines.slice(8)){if(y>267){doc.addPage();y=header();}text(v,left+2,y,8);y+=3.5;}
 const footerNotes=['Cotización comercial emitida por el CRM; no es documento tributario ni emitido por Facto.','No reserva inventario ni confirma pago.'];
 for(const v of footerNotes){if(y>267){doc.addPage();y=header();}text(v,left,y,8);y+=4;}
 const count=doc.getNumberOfPages();for(let page=1;page<=count;page++){doc.setPage(page);text(`Referencia: ${quote.folio}`,left,283,7);doc.text(`Página ${page} de ${count}`,right,283,{align:'right'});}
 return new File([doc.output('arraybuffer')],`Cotizacion-${quote.folio}.pdf`,{type:'application/pdf'});
}
