import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMarketBootstrap, type MarketBootstrap } from '../../lib/marketStudyApi';
import { marketProducts } from './marketSources';
import { marketTopTen } from './marketMath';
import { OpportunityTable } from './OpportunityTable';
export function MarketOpportunities({userId,refreshedAt}:{userId:string;refreshedAt:string|null}){
 const [data,setData]=useState<MarketBootstrap|null>(null),[error,setError]=useState(''),[mode,setMode]=useState<'all'|'current'|'transit'>('all'),[loading,setLoading]=useState(true);
 useEffect(()=>{const abort=new AbortController();setData(null);setError('');setLoading(true);getMarketBootstrap(abort.signal).then(v=>{if(!abort.signal.aborted)setData(v);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'No disponible.');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[userId,refreshedAt]);
 const ranking=useMemo(()=>data?marketTopTen(marketProducts(data),data.observations,data.reviews,mode):null,[data,mode]);
 return <section className="market-page market-card" aria-label="Oportunidades de mercado"><div className="market-section-heading"><div><p className="market-eyebrow">ESTUDIO DE MERCADO</p><h2>Top 10 de oportunidades</h2></div><Link to="/estudio-mercado">Abrir estudio</Link></div><label>Filtro de oportunidades<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="all">Actual y por llegar</option><option value="current">Existencia actual</option><option value="transit">Por llegar · teórico</option></select></label>{loading&&<p role="status">Leyendo referencias de mercado…</p>}{error&&<p role="status">Estudio de Mercado no disponible: {error} No se presenta un ranking vacío como resultado verificado.</p>}{data&&<><p className="market-muted">Lectura: {new Date(data.readAt).toLocaleString("es-CL")} · Inventario: {data.inventoryAvailable?"verificado":"no disponible"} · Tránsito: {data.importsComplete?"cobertura verificada":"cobertura incompleta"}</p>{[...data.warnings,...data.inventoryWarnings].map((w,i)=><p className="market-warning" key={i}>{w}</p>)}</>}{ranking&&<OpportunityTable ranking={ranking}/>}</section>;
}
