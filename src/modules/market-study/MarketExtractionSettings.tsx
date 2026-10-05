import { useState } from 'react';
import { getMarketExtractionSettings, saveMarketExtractionSettings, type MarketExtractionSettingsData } from '../../lib/marketStudyApi';

export function MarketExtractionSettings() {
 const [data,setData]=useState<MarketExtractionSettingsData|null>(null),[choice,setChoice]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const load=async()=>{setBusy(true);setError('');try{const result=await getMarketExtractionSettings();setData(result);setChoice(result.policy.choice);}catch(e){setError(e instanceof Error?e.message:'No se pudo leer la configuración.');}finally{setBusy(false);}};
 const save=async()=>{if(!data)return;setBusy(true);setError('');setSaved(false);try{const result=await saveMarketExtractionSettings({revision:data.policy.revision,choice});setData(result);setChoice(result.policy.choice);setSaved(true);}catch(e){setError(e instanceof Error?e.message:'No se pudo guardar.');}finally{setBusy(false);}};
 return <details className="market-card" onToggle={e=>{if(e.currentTarget.open&&!data&&!busy&&!error)void load();}}>
  <summary>Proveedor de extracción del investigador</summary>
  <p>Cambio manual para lotes nuevos. Cada lote conserva su proveedor y modelo; no hay reemplazo automático. Las equivalencias requieren revisión humana.</p>
  {busy&&<p role="status">Consultando configuración…</p>}
  {error&&<p role="alert">{error}</p>}
  {data&&<><p><strong>{data.policy.enabled?'Piloto habilitado':'Piloto desactivado'}</strong> · Revisión {data.policy.revision}. Cambiar el modelo no activa el servicio.</p>
   <div className="market-form-grid"><label>Proveedor y modelo<select aria-label="Proveedor y modelo de extracción" disabled={busy} value={choice} onChange={e=>{setChoice(e.target.value);setSaved(false);}}>
    {!data.choices.some(c=>c.choice===data.policy.choice)&&<option value={data.policy.choice}>{data.policy.choice} — no disponible en configuración vigente</option>}
    {data.choices.map(c=><option key={c.choice} value={c.choice}>{c.provider} · {c.model}</option>)}
   </select></label></div>
   <p>Topes del piloto: USD {data.policy.daily_usd}/día, USD {data.policy.pilot_usd} total y {data.policy.daily_jobs} trabajos/día. La activación y los dominios públicos requieren configuración aprobada.</p>
   {data.choices.filter(c=>c.choice===choice).map(c=><p key={c.choice}>Tarifa de referencia por millón de tokens: entrada USD {c.input_usd_per_million}, salida USD {c.output_usd_per_million}; revisada {c.rate_checked_at}. Estimación, no factura.</p>)}
   <button disabled={busy||!data.choices.some(c=>c.choice===choice)||choice===data.policy.choice} onClick={()=>void save()}>Guardar selección para lotes nuevos</button>
  </>}
  <button className="secondary" disabled={busy} onClick={()=>void load()}>Actualizar configuración</button>
  {saved&&<p role="status">Selección guardada. Los lotes existentes conservan su modelo.</p>}
 </details>;
}
