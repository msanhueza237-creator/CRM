import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Eye, Search } from 'lucide-react';
import type { MarketWebOffer, NativeStudyJob } from '../../../supabase/functions/_shared/market-native-contract';
import type { MarketProduct } from './marketMath';
import { known, toNetClp, discountScenario } from './marketMath';

const money=(n:number|null,currency='CLP')=>n===null?'Sin dato':new Intl.NumberFormat('es-CL',{style:'currency',currency,maximumFractionDigits:currency==='CLP'?0:2}).format(n);
const percent=(n:number|null)=>n===null?'Pendiente':new Intl.NumberFormat('es-CL',{maximumFractionDigits:1}).format(n)+'%';
export function marketOfferNet(offer:MarketWebOffer) {
  if(offer.identity!=='model_match'||offer.package_quantity!==1)return null;
  return toNetClp(offer.amount,offer.currency,offer.vat,offer.vat_percent,null);
}
export function MarketComparison({product,products,job,onReview}:{product:MarketProduct;products:MarketProduct[];job:NativeStudyJob|null;onReview:(index:number)=>void}) {
  const [query,setQuery]=useState(''),[sort,setSort]=useState('price'),[onlyPrices,setOnlyPrices]=useState(false),[transitKey,setTransitKey]=useState(''),[basis,setBasis]=useState('current');
  const current=products.filter(p=>p.mode==='current'&&p.sku===product.sku),incoming=products.filter(p=>p.mode==='transit'&&p.sku===product.sku);
  const actual=current.length===1?current[0]:null,transit=incoming.find(p=>p.key===transitKey)||incoming[0];
  const price=actual?.priceCurrency==='CLP'?actual.price:null,cost=actual?.costCurrency==='CLP'?actual.cost:null;
  const future=transit?.costCurrency==='CLP'?transit.cost:null;
  const today=discountScenario(price,cost,1,0,null,null).before,arrival=discountScenario(price,future,1,0,null,null).before;
  const offers=job?.result.offers||[];
  const rows=useMemo(()=>offers.map((offer,index)=>({offer,index,net:marketOfferNet(offer)})).filter(({offer})=>(!onlyPrices||known(offer.amount))&&`${offer.seller} ${offer.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>{
    if(sort==='seller')return a.offer.seller.localeCompare(b.offer.seller);
    // Raw prices in different currencies/tax bases never share a numerical rank.
    const av=a.net,bv=b.net;
    return av===null?(bv===null?a.offer.seller.localeCompare(b.offer.seller):1):bv===null?-1:sort==='highest'?bv-av:av-bv;
  }),[offers,query,sort,onlyPrices]);
  return <section className="market-comparison" aria-label="Comparativa de precios">
    <div className="market-section-heading"><h2>Comparativa · {product.sku}</h2><span className="market-muted">{job?.created_at?new Date(job.created_at).toLocaleString('es-CL'):''}</span></div>
    <div className="market-price-summary">
      <div><span>Venta actual · neto CLP</span><strong>{money(price)}</strong><small>{actual?.priceAt?`Fuente ${new Date(actual.priceAt).toLocaleDateString('es-CL')}`:'Precio pendiente de verificar'}</small></div>
      <div><span>Costo actual · Facto</span><strong>{money(cost)}</strong><small>Margen calculado {percent(today.margin)}</small></div>
      <div><span>Costo por llegar · estimado</span><strong>{money(future)}</strong><small>{transit?.eta?`Llegada ${transit.eta}`:'Sin llegada confirmada'}</small></div>
      <div><span>Margen con importacion</span><strong>{percent(arrival.margin)}</strong><small>Al precio de venta actual</small></div>
    </div>
    {incoming.length>0&&<label className="market-transit-select">Importacion<select value={transit?.key||''} onChange={e=>setTransitKey(e.target.value)}>{incoming.map(p=><option value={p.key} key={p.key}>{p.costSource}</option>)}</select></label>}
    <details className="market-muted"><summary>Origen y condiciones del calculo</summary><p>{actual?.costSource||'Costo actual no disponible.'}</p><p>{transit?.costSource||'No hay importacion con este SKU.'}</p><p>Margen bruto sobre venta neta, sin gastos generales. Costo de transito estimado, no precio de venta futuro. El orden compara solo precios con modelo, unidad, moneda e IVA identificados; sigue pendiente la equivalencia tecnica.</p>{[...(actual?.notices||[]),...(transit?.notices||[])].map((n,i)=><p key={i}>{n}</p>)}</details>
    <div className="market-compare-toolbar">
      <label><Search size={16} aria-hidden="true"/>Oferente o producto<input aria-label="Oferente o producto" type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
      <label><ArrowDownWideNarrow size={16} aria-hidden="true"/>Ordenar<select aria-label="Ordenar ofertas" value={sort} onChange={e=>setSort(e.target.value)}><option value="price">Menor precio neto</option><option value="highest">Mayor precio neto</option><option value="seller">Oferente</option></select></label>
      <label>Margen con costo<select aria-label="Margen con costo" value={basis} onChange={e=>setBasis(e.target.value)}><option value="current">Actual · Facto</option><option value="transit">Importacion estimada</option></select></label>
      <label className="market-check"><input type="checkbox" checked={onlyPrices} onChange={e=>setOnlyPrices(e.target.checked)}/>Solo con precio publicado</label>
    </div>
    <div className="market-comparison-scroll" tabIndex={0} aria-label="Tabla de ofertas">
      <table><thead><tr><th>Oferente / producto</th><th>Precio publicado</th><th>Neto por unidad CLP</th><th>Diferencia vs. venta actual</th><th>Margen con costo {basis==='current'?'actual':'por llegar'}</th><th>Estado</th><th>Revision</th></tr></thead><tbody>
        <tr className="market-own-price"><th>Climactiva · {product.name}</th><td>{money(price)}<small>Neto actual</small></td><td>{money(price)}</td><td>Referencia</td><td>{percent((basis==='current'?today:arrival).margin)}</td><td>{actual?'CRM / Facto':'Sin precio actual'}</td><td><a href={product.path}>Origen <ArrowUpRight size={14}/></a></td></tr>
        {rows.map(({offer:o,index,net})=><tr key={o.url}><th><a href={o.url} target="_blank" rel="noreferrer">{o.seller} <ArrowUpRight size={14}/></a><small>{o.title}</small></th><td>{o.currency?money(o.amount,o.currency):o.amount===null?'Pendiente':`${o.amount} · moneda pendiente`}<small>{o.vat==='gross'?'IVA incluido':o.vat==='net'?'Neto sin IVA':'IVA por verificar'}</small></td><td>{money(net)}<small>{net!==null?'Provisional':'Base no comparable'}</small></td><td>{net!==null&&price!==null?money(net-price):'Pendiente'}</td><td>{percent(discountScenario(net,basis==='current'?cost:future,1,0,null,null).before.margin)}<small>Escenario provisional</small></td><td><span>{o.availability==='available'?'Disponible':o.availability==='unavailable'?'Sin stock':'Stock por verificar'}</span><details><summary>{o.identity==='model_match'?'Modelo coincidente':'Equivalencia pendiente'}</summary><p>{o.warning}</p><small>{new Date(o.observed_at).toLocaleString('es-CL')}</small><pre>{o.evidence}</pre></details></td><td><button className="secondary market-review-icon" title={`Revisar oferta de ${o.seller}`} aria-label={`Revisar oferta de ${o.seller}`} onClick={()=>onReview(index)}><Eye size={18}/></button></td></tr>)}
      </tbody></table>
    </div>
    {job&&offers.length===0&&<p role="status">La busqueda no encontro fichas publicas verificables para este producto.</p>}
    {offers.length>0&&rows.length===0&&<p role="status">Ninguna oferta coincide con los filtros.</p>}
    {job&&<details className="market-muted"><summary>{offers.length} fuentes · Cobertura de la busqueda</summary><p>{job.result.coverage}</p>{job.result.queries?.map(q=><p key={q}>{q}</p>)}<p>{job.result.usage_note}</p></details>}
  </section>;
}
