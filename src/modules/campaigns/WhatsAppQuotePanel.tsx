import { quotePendingFields } from '../../../supabase/functions/_shared/crm-quote';
import {useEffect,useState} from 'react';
import {whatsappRequest} from '../../lib/whatsappApi';
import {crmQuotePdf} from '../../lib/crmQuotePdf';
import type {CrmQuote,QuoteParty} from '../../../supabase/functions/_shared/crm-quote';
function seedCustomer(message:string):QuoteParty {
 const rut=message.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);
 const rest=rut?message.slice((rut.index||0)+rut[0].length).trim().split(/[.\n,]+/).map(p=>p.trim()).filter(Boolean):[];
 return {rut:rut?.[0]||'',name:rest[0]||'',address:rest[1]||'',commune:rest[2]||''};
}
export function WhatsAppQuotePanel({companyId,message,sourceMessageId,onAttach,onClose,canAttach,phone,contactId}:{companyId:string;phone:string;contactId:string;message:string;sourceMessageId:string;canAttach:boolean;onAttach:(file:File,text:string)=>void;onClose:()=>void}) {
 const [contextSource]=useState(sourceMessageId);const [contextMessage]=useState(message);
 const [contextLoading,setContextLoading]=useState(true);const [quoteReady,setQuoteReady]=useState(false);const [unresolved,setUnresolved]=useState<string[]>([]);
 const [logoDataUrl,setLogoDataUrl]=useState('');
 const [id,setId]=useState(()=>crypto.randomUUID());
 const [customer,setCustomer]=useState(()=>seedCustomer(message));
 const [issuer,setIssuer]=useState<QuoteParty>({name:'Importadora Latin Chile Limitada',rut:'77.724.382-9',address:'ENC LOS QUILLAYES LT 76 F',commune:'Curacaví'});
 const [search,setSearch]=useState('soporte');const [options,setOptions]=useState<Array<{sku:string;name:string}>>([]);
 const [lines,setLines]=useState<Array<{sku:string;name:string;quantity:number}>>([]);
 const [validDays,setValidDays]=useState(7);const includeVat=true;
 const conditions='';
 const [quote,setQuote]=useState<CrmQuote|null>(null);const [saved,setSaved]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [confirmed,setConfirmed]=useState(false);
 useEffect(()=>{let alive=true;const query=new URLSearchParams({companyId,phone,contactId,sourceMessageId:contextSource});
 void whatsappRequest<{lines:typeof lines;unresolved:string[];customer:QuoteParty;ready:boolean;missing:string[]}>(`whatsapp-quote-context?${query}`).then(r=>{if(alive){setLines(r.lines);setUnresolved(r.unresolved);setCustomer(r.customer);setQuoteReady(r.ready);if(!r.ready)setError(r.missing.length?`El cliente debe enviar: ${r.missing.join(', ')}.`:'Primero debe elegir modelo y cantidad y solicitar el PDF formal.');}}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'No se pudo recuperar la selección anterior.');}).finally(()=>{if(alive)setContextLoading(false);});return()=>{alive=false;};},[companyId,phone,contactId,contextSource]);
 const invalidate=()=>{if(saved){setId(crypto.randomUUID());setSaved(false);}setQuote(null);setConfirmed(false);};
 const payload=()=>({id,companyId,sourceMessageId:contextSource,logoDataUrl,issuer,customer,lines:lines.map(l=>({sku:l.sku,quantity:l.quantity})),validDays,pricesIncludeVat:includeVat,conditions});
 async function operate(action:'search'|'preview'|'register'){
  setBusy(true);setError('');
  try{
   if(action==='search'){const r=await whatsappRequest<{products:typeof options}>(`whatsapp-quote-catalog?search=${encodeURIComponent(search)}`);setOptions(r.products);}
   else if(action==='preview'){const nextId=saved?crypto.randomUUID():id;setId(nextId);setSaved(false);setQuote(null);setConfirmed(false);const r=await whatsappRequest<{quote:CrmQuote}>('whatsapp-quote-preview',{...payload(),id:nextId});setQuote(r.quote);}
   else {const r=await whatsappRequest<{quote:CrmQuote}>('whatsapp-quote-register',{...payload(),expected:quote,confirm:confirmed});setQuote(r.quote);setSaved(true);}
  }catch(e){setError(e instanceof Error?e.message:'No se pudo preparar la cotización.');}finally{setBusy(false);}
 }
 async function pdf(attach:boolean){if(!quote||!saved)return;setBusy(true);setError('');try{const file=await crmQuotePdf(quote);if(attach){onAttach(file,`Adjunto cotización ${quote.folio} por $${quote.total.toLocaleString('es-CL')} CLP.`);onClose();}else{const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}}catch{setError('No se pudo generar el PDF. La cotización sigue guardada.');}finally{setBusy(false);}}
 const partyFields=(label:string,value:QuoteParty,set:(p:QuoteParty)=>void)=><fieldset disabled={busy||contextLoading}><legend>{label}</legend>{(['name','rut','address','commune'] as const).map(k=><label key={k}>{({name:'Nombre o razón social',rut:'RUT',address:'Dirección',commune:'Comuna'})[k]}<input value={value[k]} maxLength={k==='rut'?15:200} onChange={e=>{invalidate();set({...value,[k]:e.target.value});}}/></label>)}</fieldset>;
 return <section className="wa-quote-panel" aria-label="Cotización comercial CRM">
  <strong>Cotización comercial CRM</strong><button type="button" disabled={busy} onClick={onClose}>Cerrar cotización</button>
  <p>Se recuperan los modelos y cantidades elegidos en la conversación. Revisa los datos antes de emitir. El PDF se enviará solo cuando pulses Enviar respuesta.</p>
  {quotePendingFields({issuer,customer}).length>0&&<p className="wa-alert">Para el PDF formal el cliente debe completar sus datos. Datos pendientes: {quotePendingFields({issuer,customer}).join('; ')}.</p>}
  {contextLoading&&<p role="status">Recuperando productos elegidos en la conversación...</p>}
  {unresolved.map((note,i)=><p key={i} className="wa-alert">{note}</p>)}
  {error&&<p role="alert" className="wa-alert">{error}</p>}
  <label>Logo del emisor (opcional, PNG/JPG hasta 180 KB)<input type="file" accept="image/png,image/jpeg" disabled={busy||contextLoading} onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(!['image/png','image/jpeg'].includes(f.type)||f.size>180000){setError('Usa PNG o JPG de hasta 180 KB.');return;}invalidate();const reader=new FileReader();reader.onload=()=>setLogoDataUrl(String(reader.result));reader.readAsDataURL(f);}}/></label>
  {partyFields('Emisor' ,issuer,setIssuer)}{partyFields('Cliente',customer,setCustomer)}
  <fieldset disabled={busy||contextLoading}><legend>Productos Tiendanube</legend><label>Buscar nombre o código<input value={search} onChange={e=>setSearch(e.target.value)}/></label><button type="button" onClick={()=>void operate('search')}>Buscar productos</button>
  <label>Seleccionar modelo<select value="" onChange={e=>{const p=options.find(p=>p.sku===e.target.value);if(p&&!lines.some(l=>l.sku===p.sku)){invalidate();setUnresolved(notes=>notes.filter(note=>!['muro','techo'].some(group=>p.name.toLowerCase().includes(group)&&note.includes(`de ${group}:`))));const request=[...contextMessage.toLowerCase().matchAll(/(\d+)\s+soportes?\s+(?:de\s+)?(muro|techo)/g)].find(m=>p.name.toLowerCase().includes(m[2]));setLines([...lines,{...p,quantity:request?Number(request[1]):1}]);}}}><option value="">Selecciona un producto</option>{options.map((p,i)=><option key={p.sku+i} value={p.sku}>{p.name} ({p.sku})</option>)}</select></label>
  {lines.map((p,i)=><div key={p.sku} className="wa-quote-line"><strong>{p.name} ({p.sku})</strong><label>Cantidad<input type="number" min={1} max={9999} value={p.quantity} onChange={e=>{invalidate();setLines(lines.map((l,j)=>j===i?{...l,quantity:Number(e.target.value)}:l));}}/></label><button type="button" onClick={()=>{invalidate();setLines(lines.filter((_,j)=>i!==j));}}>Quitar {p.sku}</button></div>)}
  <label>Vigencia en días<input type="number" min={1} max={90} value={validDays} onChange={e=>{invalidate();setValidDays(Number(e.target.value));}}/></label>
  <p>Precios de Tiendanube con IVA 19% incluido. El neto se calcula dividiendo por 1,19; no se agrega IVA al precio de la tienda.</p>
  <p>Observaciones en blanco. Al pie del PDF se incluyen los datos de transferencia de Importadora Latin Chile.</p>
  <button type="button" disabled={!lines.length||!quoteReady} onClick={()=>void operate('preview')}>Consultar precios y preparar cotización</button></fieldset>
  {quote&&<div className="wa-quote-review"><strong>{saved?`Cotización ${quote.quoteNumber??quote.folio}`:'Vista previa: número asignado al guardar'}</strong>{quote.lines.map(l=><p key={l.sku}>{l.quantity} × {l.name} · Neto unitario: ${(l.unitPrice/1.19).toLocaleString('es-CL',{minimumFractionDigits:2,maximumFractionDigits:2})} CLP · Precio con IVA: ${l.unitPrice.toLocaleString('es-CL')} CLP c/u · Importe con IVA: ${l.amount.toLocaleString('es-CL')} CLP</p>)}<p>Neto: ${quote.net.toLocaleString('es-CL')} · IVA: ${quote.vat.toLocaleString('es-CL')} · Total: ${quote.total.toLocaleString('es-CL')} CLP</p>
  {!saved?<><label className="wa-quote-confirm"><input type="checkbox" checked={confirmed} disabled={busy||contextLoading} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo cliente, emisor, productos, cantidades, IVA y condiciones.</label><button type="button" disabled={busy||!confirmed} onClick={()=>void operate('register')}>Guardar cotización en ficha</button></>:<><p>Cotización guardada en la ficha del cliente.</p><button type="button" disabled={busy||contextLoading} onClick={()=>void pdf(false)}>Descargar PDF</button><button type="button" disabled={busy||!canAttach} onClick={()=>void pdf(true)}>Adjuntar PDF a respuesta</button></>}
  </div>}
 </section>;
}
