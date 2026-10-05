import { useEffect, useState } from 'react';
import { createResearchAccess, getResearchAccess, revokeResearchAccess, type ResearchAccessData } from '../../lib/marketStudyApi';

export function MarketResearchAccess() {
 const [data,setData]=useState<ResearchAccessData|null>(null),[provider,setProvider]=useState('market-worker-pilot-marco'),[skus,setSkus]=useState(''),[expiry,setExpiry]=useState(''),[ready,setReady]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[secret,setSecret]=useState(''),[show,setShow]=useState(false),[revoke,setRevoke]=useState('');
 const load=async()=>{setBusy(true);setError('');setConfirm(false);try{setData(await getResearchAccess());}catch{setError('No se pudo consultar el acceso. No se creó ninguna credencial desde esta consulta.');}finally{setBusy(false);}};
 useEffect(()=>{if(!secret)return;const clear=()=>{setSecret('');setShow(false);};const hidden=()=>{if(document.hidden)clear();};const timer=setTimeout(clear,60000);window.addEventListener('pagehide',clear);document.addEventListener('visibilitychange',hidden);return()=>{clearTimeout(timer);window.removeEventListener('pagehide',clear);document.removeEventListener('visibilitychange',hidden);};},[secret]);
 const create=async()=>{if(!data||!confirm||!ready)return;setBusy(true);setError('');try{const result=await createResearchAccess({request_id:crypto.randomUUID(),provider,skus:skus.split(',').map(s=>s.trim()).filter(Boolean),expires_at:new Date(expiry).toISOString(),policy:data.policy,secure_destination_ready:true,confirm:'CREATE'});setSecret(result.api_key);setShow(false);setConfirm(false);setReady(false);setData(await getResearchAccess());}catch{setConfirm(false);setError('Creación no confirmada. Actualiza el listado antes de repetir; revoca cualquier acceso cuya clave no recibiste.');setData(null);}finally{setBusy(false);}};
 const remove=async()=>{setBusy(true);setError('');try{await revokeResearchAccess(revoke);setRevoke('');setSecret('');setData(await getResearchAccess());}catch{setError('Revocación no confirmada. Actualiza el listado y comprueba el estado.');}finally{setBusy(false);}};
 const configured=!!data&&data.policy.public_hosts.length>0&&!!data.policy.approved_until&&new Date(data.policy.approved_until).getTime()>Date.now()&&data.policy.daily_usd<=0.25&&data.policy.pilot_usd<=0.25&&data.policy.daily_jobs<=10;
 return <details className="market-card" onToggle={e=>{if(e.currentTarget.open&&!data&&!busy&&!error)void load();if(!e.currentTarget.open){setSecret('');setShow(false);setConfirm(false);}}}>
  <summary>Acceso del investigador</summary>
  <p>Solo administradores. No actives este acceso hasta aprobar su creación real. La clave no activa el piloto ni cambia precios.</p>
  <p>Fuentes permitidas: Refrimarket, RefriRepuestos, ANWO, MoretoClima, Antartic, Acondiparts, Climalider y Frioline. Las fichas y dominios exactos requieren verificación previa.</p>
  {error&&<p role="alert">{error}</p>}
  {data&&<><p>Modelo para lotes nuevos: {data.policy.choice}. Usa el selector manual de proveedor; los lotes existentes conservan su modelo. Dominios configurados: {data.policy.public_hosts.join(', ')||'Pendientes'}. Presupuesto: USD {data.policy.pilot_usd} total / {data.policy.daily_usd} por día. Máximo {data.policy.daily_jobs} trabajos por día UTC.</p>
   {data.usage?<p>Ledger de extracción acumulado: {data.usage.jobs} trabajos; estimación conocida USD {data.usage.estimated_usd}; reservas sin liquidar USD {data.usage.held_usd}; {data.usage.unknown_jobs} resultados desconocidos. No es factura del proveedor. Último trabajo: {data.usage.last_job_at||'Sin trabajos'}. SKUs enviados: {data.usage.skus.join(', ')||'Ninguno'}. Un trabajo no acredita investigación completa ni equivalencia.</p>:<p>Consumo y última actividad: no disponibles en este backend.</p>}
   <p>Las observaciones y equivalencias se revisan en Investigaciones. El estado de conexión del worker y su próxima ejecución no están disponibles; esta pantalla no afirma que esté funcionando.</p>
   <p>Permisos: {data.scopes.join(' · ')}</p><p>Fin de autorización: {data.policy.approved_until||'Pendiente'}. Caducidad máxima: una hora y antes del siguiente día UTC.</p>
   {!configured&&<p role="status">Creación bloqueada: falta política aprobada con dominios, fecha y topes del piloto. Esta pantalla no amplía ese alcance.</p>}
   <fieldset disabled={busy||!!secret}><legend>Preparar acceso dedicado</legend>
    <label>Identidad del investigador<input value={provider} onChange={e=>{setProvider(e.target.value);setConfirm(false);}} autoComplete="off"/></label>
    <label>SKUs verificados, separados por coma<input value={skus} onChange={e=>{setSkus(e.target.value);setConfirm(false);}} autoComplete="off"/></label>
    <label>Caducidad (hora local del navegador)<input type="datetime-local" value={expiry} onChange={e=>{setExpiry(e.target.value);setConfirm(false);}}/></label>
    <p>La recepción segura del worker aún debe verificarse. El propietario debe introducir la clave en un campo oculto que no la registre ni la guarde en texto plano. No pegarla en chat, terminal o archivos.</p>
    <label><input type="checkbox" checked={ready} onChange={e=>{setReady(e.target.checked);setConfirm(false);}}/> He verificado un destino seguro del worker para introducir la clave.</label>
    <label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/> Confirmo crear la credencial con la identidad, SKUs, dominios, permisos, presupuesto y caducidad mostrados.</label>
    <button disabled={!configured||!ready||!confirm||!skus.trim()||!expiry} onClick={()=>void create()}>Crear credencial dedicada</button>
   </fieldset>
   {secret&&<div><p>Clave de una sola entrega. Se elimina de esta vista en 60 segundos, al ocultar la pestaña o cerrar el panel. Si la pierdes, revoca el acceso y crea otro; no se recupera. No captures esta pantalla.</p><label>Clave del investigador<input readOnly type={show?'text':'password'} value={secret} autoComplete="off" spellCheck={false}/></label><button onClick={()=>setShow(!show)}>{show?'Ocultar clave':'Mostrar clave'}</button><button onClick={()=>{setSecret('');setShow(false);}}>Descartar clave de la vista</button></div>}
   <ul>{data.integrations.map(i=><li key={i.id}><strong>{i.provider}</strong> — {i.active?'Activo':'Revocado o vencido'} — {i.skus.join(', ')} — {i.expires_at} <button disabled={busy||!i.active} onClick={()=>setRevoke(i.id)}>Revocar {i.provider}</button></li>)}</ul>
   {revoke&&<div role="alert"><p>¿Revocar el acceso {data.integrations.find(i=>i.id===revoke)?.provider}? Las observaciones y reservas se conservarán.</p><button disabled={busy} onClick={()=>void remove()}>Confirmar revocación</button><button onClick={()=>setRevoke('')}>Cancelar revocación</button></div>}
  </>}
  <button disabled={busy} onClick={()=>void load()}>Actualizar accesos</button>
 </details>;
}
