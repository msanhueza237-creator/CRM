import {useState} from 'react';
import {whatsappRequest} from '../../lib/whatsappApi';
import {crmQuotePdf} from '../../lib/crmQuotePdf';
import type {CrmQuote,QuoteParty} from '../../../supabase/functions/_shared/crm-quote';
function seedCustomer(message:string):QuoteParty {
 const rut=message.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);
 const rest=rut?message.slice((rut.index||0)+rut[0].length).trim().split(/[.\n,]+/).map(p=>p.trim()).filter(Boolean):[];
 return {rut:rut?.[0]||'',name:rest[0]||'',address:rest[1]||'',commune:rest[2]||''};
}
export function WhatsAppQuotePanel({companyId,message,sourceMessageId,onAttach,onClose,canAttach}:{companyId:string;message:string;sourceMessageId:string;canAttach:boolean;onAttach:(file:File,text:string)=>void;onClose:()=>void}) {
 const [logoDataUrl,setLogoDataUrl]=useState('');
 const [id,setId]=useState(()=>crypto.randomUUID());
 const [customer,setCustomer]=useState(()=>seedCustomer(message));
 const [issuer,setIssuer]=useState<QuoteParty>({name:'Importadora Latin Chile Limitada',rut:'77.724.382-9',address:'',commune:''});
 const [search,setSearch]=useState('soporte');const [options,setOptions]=useState<Array<{sku:string;name:string}>>([]);
 const [lines,setLines]=useState<Array<{sku:string;name:string;quantity:number}>>([]);
 const [validDays,setValidDays]=useState(7);const [includeVat,setIncludeVat]=useState(true);
 const [conditions,setConditions]=useState('Despacho no incluido. Disponibilidad sujeta a confirmación al aceptar la cotización.');
 const [quote,setQuote]=useState<CrmQuote|null>(null);const [saved,setSaved]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [confirmed,setConfirmed]=useState(false);
 const invalidate=()=>{if(saved){setId(crypto.randomUUID());setSaved(false);}setQuote(null);setConfirmed(false);};
 const payload=()=>({id,companyId,sourceMessageId,logoDataUrl,issuer,customer,lines:lines.map(l=>({sku:l.sku,quantity:l.quantity})),validDays,pricesIncludeVat:includeVat,conditions});
 async function operate(action:'search'|'preview'|'register'){
  setBusy(true);setError('');
  try{
   if(action==='search'){const r=await whatsappRequest<{products:typeof options}>(`whatsapp-quote-catalog?search=${encodeURIComponent(search)}`);setOptions(r.products);}
   else if(action==='preview'){const nextId=saved?crypto.randomUUID():id;setId(nextId);setSaved(false);setQuote(null);setConfirmed(false);const r=await whatsappRequest<{quote:CrmQuote}>('whatsapp-quote-preview',{...payload(),id:nextId});setQuote(r.quote);}
   else {const r=await whatsappRequest<{quote:CrmQuote}>('whatsapp-quote-register',{...payload(),expected:quote,confirm:confirmed});setQuote(r.quote);setSaved(true);}
  }catch(e){setError(e instanceof Error?e.message:'No se pudo preparar la cotización.');}finally{setBusy(false);}
 }
 async function pdf(attach:boolean){if(!quote||!saved)return;setBusy(true);setError('');try{const file=await crmQuotePdf(quote);if(attach){onAttach(file,`Adjunto cotización ${quote.folio} por $${quote.total.toLocaleString('es-CL')} CLP.`);onClose();}else{const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}}catch{setError('No se pudo generar el PDF. La cotización sigue guardada.');}finally{setBusy(false);}}
 const partyFields=(label:string,value:QuoteParty,set:(p:QuoteParty)=>void)=><fieldset disabled={busy}><legend>{label}</legend>{(['name','rut','address','commune'] as const).map(k=><label key={k}>{({name:'Nombre o razón social',rut:'RUT',address:'Dirección',commune:'Comuna'})[k]}<input value={value[k]} maxLength={k==='rut'?15:200} onChange={e=>{invalidate();set({...value,[k]:e.target.value});}}/></label>)}</fieldset>;
 return <section className="wa-quote-panel" aria-label="Cotización comercial CRM">
  <strong>Cotización comercial CRM</strong><button type="button" disabled={busy} onClick={onClose}>Cerrar cotización</button>
  <p>Revisa los datos extraídos del mensaje y selecciona los modelos exactos. El PDF se enviará solo cuando pulses Enviar respuesta.</p>
  {error&&<p role="alert" className="wa-alert">{error}</p>}
  <label>Logo del emisor (opcional, PNG/JPG hasta 180 KB)<input type="file" accept="image/png,image/jpeg" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(!f)return;if(!['image/png','image/jpeg'].includes(f.type)||f.size>180000){setError('Usa PNG o JPG de hasta 180 KB.');return;}invalidate();const reader=new FileReader();reader.onload=()=>setLogoDataUrl(String(reader.result));reader.readAsDataURL(f);}}/></label>
  {partyFields('Emisor' ,issuer,setIssuer)}{partyFields('Cliente',customer,setCustomer)}
  <fieldset disabled={busy}><legend>Productos Tiendanube</legend><label>Buscar nombre o código<input value={search} onChange={e=>setSearch(e.target.value)}/></label><button type="button" onClick={()=>void operate('search')}>Buscar productos</button>
  <label>Seleccionar modelo<select value="" onChange={e=>{const p=options.find(p=>p.sku===e.target.value);if(p&&!lines.some(l=>l.sku===p.sku)){invalidate();const request=[...message.toLowerCase().matchAll(/(\d+)\s+soportes?\s+(?:de\s+)?(muro|techo)/g)].find(m=>p.name.toLowerCase().includes(m[2]));setLines([...lines,{...p,quantity:request?Number(request[1]):1}]);}}}><option value="">Selecciona un producto</option>{options.map((p,i)=><option key={p.sku+i} value={p.sku}>{p.name} ({p.sku})</option>)}</select></label>
  {lines.map((p,i)=><div key={p.sku} className="wa-quote-line"><strong>{p.name} ({p.sku})</strong><label>Cantidad<input type="number" min={1} max={9999} value={p.quantity} onChange={e=>{invalidate();setLines(lines.map((l,j)=>j===i?{...l,quantity:Number(e.target.value)}:l));}}/></label><button type="button" onClick={()=>{invalidate();setLines(lines.filter((_,j)=>i!==j));}}>Quitar {p.sku}</button></div>)}
  <label>Vigencia en días<input type="number" min={1} max={90} value={validDays} onChange={e=>{invalidate();setValidDays(Number(e.target.value));}}/></label>
  <label>Precios de Tiendanube<select value={includeVat?'included':'net'} onChange={e=>{invalidate();setIncludeVat(e.target.value==='included');}}><option value="included">Incluyen IVA 19%</option><option value="net">Son netos, agregar IVA 19%</option></select></label>
  <label>Condiciones de despacho y pago<textarea value={conditions} maxLength={1500} onChange={e=>{invalidate();setConditions(e.target.value);}}/></label>
  <button type="button" disabled={!lines.length} onClick={()=>void operate('preview')}>Consultar precios y preparar cotización</button></fieldset>
  {quote&&<div className="wa-quote-review"><strong>{quote.folio}</strong>{quote.lines.map(l=><p key={l.sku}>{l.quantity} × {l.name} · ${l.unitPrice.toLocaleString('es-CL')} CLP c/u</p>)}<p>Neto: ${quote.net.toLocaleString('es-CL')} · IVA: ${quote.vat.toLocaleString('es-CL')} · Total: ${quote.total.toLocaleString('es-CL')} CLP</p>
  {!saved?<><label className="wa-quote-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo cliente, emisor, productos, cantidades, IVA y condiciones.</label><button type="button" disabled={busy||!confirmed} onClick={()=>void operate('register')}>Guardar cotización en ficha</button></>:<><p>Cotización guardada en la ficha del cliente.</p><button type="button" disabled={busy} onClick={()=>void pdf(false)}>Descargar PDF</button><button type="button" disabled={busy||!canAttach} onClick={()=>void pdf(true)}>Adjuntar PDF a respuesta</button></>}
  </div>}
 </section>;
}
