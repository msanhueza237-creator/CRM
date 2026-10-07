import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { whatsappRequest } from "../../lib/whatsappApi";
type Metrics = {
  accepted:number; sent:number; delivered:number; read:number; failed:number; pending:number;
  readRecipients:number; readRate:number|null; checkedAt:string;
  templates:Array<{id:string;name:string;language:string;accepted:number;sent:number;delivered:number;read:number;failed:number}>;
};
export function WhatsAppDeliveryMetrics({campaignId}: {campaignId:string}) {
  const [data,setData]=useState<Metrics|null>(null);
  const [error,setError]=useState("");
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true, loading=false;
    const load=async()=>{
      if(loading)return;
      loading=true;
      try {
        const result=await whatsappRequest<Metrics>(`whatsapp-delivery?${new URLSearchParams({campaignId})}`);
        if(active){setData(result);setError("");}
      } catch(e){if(active)setError(e instanceof Error?e.message:"No se pudo actualizar.");}
      finally {loading=false;}
    };
    setData(null);void load();
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void load();},15000);
    return()=>{active=false;clearInterval(timer);};
  },[campaignId,refresh]);
  return <section aria-label="Entrega WhatsApp" style={{marginTop:24,borderTop:"1px solid #dfe7ea",paddingTop:16}}>
    <div className="panel-heading"><h3>Confirmaciones de Meta</h3><button className="ghost-button" type="button" title="Actualizar confirmaciones" aria-label="Actualizar confirmaciones" onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={18}/></button></div>
    {error && <p role="alert">{error}</p>}
    {!data ? <p>{error ? "Métricas no disponibles" : "Consultando confirmaciones…"}</p> : <>
      <dl style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(125px,1fr))",gap:12}}>
        {([["Aceptados",data.accepted],["Enviados",data.sent],["Entregados",data.delivered],["Leídos confirmados",data.read],["Fallidos",data.failed],["Sin confirmación",data.pending],["Destinatarios que leyeron",data.readRecipients],["Lectura / entregados",data.readRate===null?"—":`${(data.readRate*100).toFixed(1)}%`]] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd style={{margin:0,fontWeight:700,fontSize:22}}>{value}</dd></div>)}
      </dl>
      <p className="muted">Lecturas confirmadas por Meta. Sin confirmación de lectura no significa que el mensaje no se haya leído. No mide clics ni apertura del catálogo.</p>
      {data.templates.length>0 && <div style={{overflowX:"auto"}}><table><thead><tr><th>Plantilla / idioma</th><th>Enviados</th><th>Entregados</th><th>Leídos</th><th>Fallidos</th></tr></thead><tbody>{data.templates.map(t=><tr key={`${t.id}:${t.language}`}><td style={{overflowWrap:"anywhere"}}>{t.name}<br/><small>{t.language}</small></td><td>{t.sent}</td><td>{t.delivered}</td><td>{t.read}</td><td>{t.failed}</td></tr>)}</tbody></table></div>}
      <small className="muted">Actualizado: {new Date(data.checkedAt).toLocaleString("es-CL")}</small>
    </>}
  </section>;
}
