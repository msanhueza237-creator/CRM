import { useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Eye, Search } from 'lucide-react';
import type { MarketWebOffer, NativeStudyJob } from '../../../supabase/functions/_shared/market-native-contract';
import type { MarketProduct, MarketEvidenceFreshness } from './marketMath';
import { known, toNetClp, discountScenario, marketTarget, channelScenario } from './marketMath';
import Decimal from 'decimal.js';
import type { StoredMarketObservation, MarketReview } from '../../../supabase/functions/_shared/market-study-contract';
import { marketTargetReferences } from './marketMath';

const money=(n:number|null,currency='CLP')=>n===null?'Pendiente de respaldo':new Intl.NumberFormat('es-CL',{style:'currency',currency,maximumFractionDigits:currency==='CLP'?0:2}).format(n);
const percent=(n:number|null)=>n===null?'Pendiente':new Intl.NumberFormat('es-CL',{maximumFractionDigits:1}).format(n)+'%';
export function marketOfferNet(offer:MarketWebOffer) {
  if(offer.identity!=='model_match'||offer.package_quantity!==1)return null;
  return toNetClp(offer.amount,offer.currency,offer.vat,offer.vat_percent,null);
}
const publishedUnitNet=(offer:MarketWebOffer)=>offer.package_quantity===1?toNetClp(offer.amount,offer.currency,offer.vat,offer.vat_percent,null):null;
const identityLabel={model_match:'Identidad/modelo coincidente · confirmar técnicamente',similar:'Producto similar · por verificar',different:'Diferencias detectadas',possible:'Equivalencia pendiente'};
export function MarketComparison({product,products,job,onReview,observations=[],reviews=[],evidence={}}:{product:MarketProduct;products:MarketProduct[];job:NativeStudyJob|null;observations?:StoredMarketObservation[];reviews?:MarketReview[];evidence?:MarketEvidenceFreshness;onReview:(index:number)=>void}) {
  const [query,setQuery]=useState(''),[sort,setSort]=useState('price'),[onlyPrices,setOnlyPrices]=useState(false),[transitKey,setTransitKey]=useState(''),[basis,setBasis]=useState('current'),[targetMode,setTargetMode]=useState('median'),[manual,setManual]=useState(''),[desired,setDesired]=useState('');
  const linkedSku=product.mode==='transit'&&product.relatedCurrentSku!==undefined?product.relatedCurrentSku:product.sku;
  const current=products.filter(p=>p.mode==='current'&&p.sku===linkedSku),incoming=products.filter(p=>p.mode==='transit'&&(p.key===product.key||(p.relatedCurrentSku!==undefined?p.relatedCurrentSku===linkedSku&&linkedSku!==null:p.sku===product.sku)));
  const actual=current.length===1?current[0]:null,transit=incoming.find(p=>p.key===transitKey)||incoming.find(p=>p.key===product.key)||incoming[0];
  const price=actual?.priceCurrency==='CLP'?actual.price:null,cost=actual?.costCurrency==='CLP'?actual.cost:null;
  const future=transit?.costCurrency==='CLP'?transit.cost:null;
  const today=discountScenario(price,cost,1,0,null,null).before,arrival=discountScenario(price,future,1,0,null,null).before;
  const offers=job?.result.offers||[];
  const reference=marketTargetReferences(product,job,observations,reviews,Date.now(),evidence);
  const eligible=reference.references.map(o=>o.net);
  const median=eligible.length?eligible.length%2?eligible[(eligible.length-1)/2]:new Decimal(eligible[eligible.length/2-1]).plus(eligible[eligible.length/2]).div(2).toNumber():null;
  const target=targetMode==='manual'?manual!==''&&Number.isFinite(Number(manual))&&Number(manual)>0?Number(manual):null:targetMode==='lowest'?eligible[0]??null:median;
  const margin=desired!==''&&Number.isFinite(Number(desired))&&Number(desired)>=0&&Number(desired)<100?Number(desired):null;
  const chosenCost=basis==='current'?cost:future,objective=marketTarget(price,chosenCost,target,margin);
  const rows=offers.map((offer,index)=>{const match=reference.references.find(r=>r.url===offer.url);return {offer,index,net:match?.net??null,reviewed:match?.reviewed===true,savedReview:reference.reviewed.offered.find(entry=>entry.observation.payload.source_url===offer.url),publishedNet:publishedUnitNet(offer)};}).filter(({offer})=>(!onlyPrices||known(offer.amount))&&`${offer.seller} ${offer.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b)=>{
    if(sort==='seller')return a.offer.seller.localeCompare(b.offer.seller);
    // Raw prices in different currencies/tax bases never share a numerical rank.
    const av=a.net,bv=b.net;
    return av===null?(bv===null?a.offer.seller.localeCompare(b.offer.seller):1):bv===null?-1:sort==='highest'?bv-av:av-bv;
  });
  return <section className="market-comparison" aria-label="Comparativa de precios">
    <div className="market-section-heading"><h2>Comparativa · {product.name}</h2><span className="market-muted">{job?.created_at?new Date(job.result.refreshed_at||job.created_at).toLocaleString('es-CL',{timeZone:'America/Santiago'}):''}</span></div>
    <div className="market-price-summary">
      <div><span>Venta actual · neto CLP</span><strong>{money(price)}</strong><small>{actual?.priceAt?`Fuente ${new Date(actual.priceAt).toLocaleDateString('es-CL')}`:'Precio pendiente de verificar'}</small></div>
      <div><span>Costo actual · Facto</span><strong>{money(cost)}</strong><small>{actual?.costCurrencyAssumed?'CLP supuesto · moneda pendiente de confirmar':'Costo registrado de producto'}</small><small>Margen {actual?.costCurrencyAssumed?'provisional':'calculado'} {percent(today.margin)}</small></div>
      <div><span>Costo por llegar · estimado</span><strong>{money(future)}</strong><small>{transit?.eta?`Llegada estimada ${transit.eta}`:transit?'Sin llegada confirmada':'Sin linea coincidente en importaciones activas'}</small></div>
      <div><span>Margen con importacion</span><strong>{percent(arrival.margin)}</strong><small>Al precio de venta actual</small></div>
    </div>
    <section className="market-target" aria-label="Precio de mercado objetivo">
      <h3>Mercado observado · comparables confirmados</h3>
      <div className="market-price-summary"><div><span>Mínimo neto CLP</span><strong>{money(eligible[0]??null)}</strong></div><div><span>Mediana neta CLP</span><strong>{money(median)}</strong></div><div><span>Máximo neto CLP</span><strong>{money(eligible[eligible.length-1]??null)}</strong></div></div>
      <div className="market-compare-toolbar">
        <label>Referencia<select aria-label="Referencia objetivo" value={targetMode} onChange={e=>setTargetMode(e.target.value)}><option value="median">Mediana de ofertas</option><option value="lowest">Menor precio</option><option value="manual">Precio elegido</option></select></label>
        {targetMode==='manual'&&<label>Objetivo neto CLP<input aria-label="Objetivo neto CLP" type="number" min="1" step="1" value={manual} onChange={e=>setManual(e.target.value)}/></label>}
        <label>Margen deseado (%)<input aria-label="Margen deseado (%)" type="number" min="0" max="99.9" step="0.1" value={desired} onChange={e=>setDesired(e.target.value)}/></label>
      </div>
      <div className="market-price-summary">
        <div><span>Escenario neto / con IVA 19%</span><strong>{money(target)}</strong><small>{money(objective.gross)} con IVA</small></div>
        <div><span>Margen al precio objetivo</span><strong>{percent(objective.margin)}</strong><small>Utilidad bruta {money(objective.profit)} por unidad</small></div>
        <div><span>Ajuste de venta vs. actual</span><strong>{money(objective.priceChange)}</strong><small>{percent(objective.priceChangePercent)}</small></div>
        <div><span>Costo maximo para {percent(margin)}</span><strong>{money(objective.maxCost)}</strong><small>Reduccion necesaria {money(objective.costReduction)}</small></div>
      </div>
      <p className="market-muted">Simulación con costo {basis==='current'?'actual de Facto':'estimado de importacion'}. {eligible.length} ofertas con base comparable; {reference.usesReviewed?'equivalencias revisadas y ofertas vigentes':'sin equivalencias confirmadas; los precios candidatos no integran este cálculo'}. No modifica precios ni autoriza descuentos.</p>
      {targetMode!=='manual'&&eligible.length===0&&<div role="status" className="market-warning">
        {!job?'No hay una busqueda seleccionada ni ofertas revisadas comparables.':job.state!=='completed'?`La busqueda no se completo: ${job.result.error||'consulta el historial antes de reintentar.'}`:offers.length===0?'La busqueda finalizo sin fichas publicas verificables.':`${offers.filter(o=>o.amount!==null).length} de ${offers.length} fuentes tienen precio publicado, pero ninguna cumple la base de comparacion.`}
        <p>Revisa abajo los errores de lectura, moneda, IVA, presentacion, stock, fecha y equivalencia. Un precio ausente no es cero. La primera equivalencia requiere revisión humana. Actualizar precio o stock conserva esa revisión si hay evidencia técnica completa sin cambios; un fallo comercial suspende el precio, no borra la aprobación histórica.</p>
        {reference.reviewed.offered.map(o=><p key={o.observation.id}>{o.observation.payload.seller}: {o.reasons.join(' ')}</p>)}
      </div>}
      {reference.usesReviewed&&<details><summary>Fuentes revisadas del objetivo</summary>{reference.references.map(o=><p key={o.url}><a href={o.url} target="_blank" rel="noreferrer">{o.seller}</a> · {money(o.net)} neto por unidad interna · lectura comercial {new Date(o.observed_at).toLocaleString('es-CL')} · revisión humana {new Date(o.reviewed_at).toLocaleString('es-CL')}{o.reused?' · equivalencia técnica conservada':''}</p>)}</details>}
    </section>
    <ChannelSimulations cost={chosenCost} source={basis==='current'?actual?.costSource:transit?.costSource}/>
    {incoming.length>0&&<label className="market-transit-select">Importacion<select value={transit?.key||''} onChange={e=>setTransitKey(e.target.value)}>{incoming.map(p=><option value={p.key} key={p.key}>{p.costSource}</option>)}</select></label>}
    <details className="market-muted"><summary>Origen y condiciones del calculo</summary><p>{actual?.costSource||'Costo actual no disponible.'}</p><p>{transit?.costSource||'No hay importacion con este SKU.'}</p><p>Margen bruto sobre venta neta, sin gastos generales. Costo de transito estimado, no precio de venta futuro. El orden compara solo precios con modelo, unidad, moneda e IVA identificados; sigue pendiente la equivalencia tecnica.</p>{[...(actual?.notices||[]),...(transit?.notices||[])].map((n,i)=><p key={i}>{n}</p>)}</details>
    <div className="market-compare-toolbar">
      <label><Search size={16} aria-hidden="true"/>Oferente o producto<input aria-label="Oferente o producto" type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
      <label><ArrowDownWideNarrow size={16} aria-hidden="true"/>Ordenar<select aria-label="Ordenar ofertas" value={sort} onChange={e=>setSort(e.target.value)}><option value="price">Menor precio neto</option><option value="highest">Mayor precio neto</option><option value="seller">Oferente</option></select></label>
      <label>Margen con costo<select aria-label="Margen con costo" value={basis} onChange={e=>setBasis(e.target.value)}><option value="current">Actual · Facto</option><option value="transit">Importacion estimada</option></select></label>
      <label className="market-check"><input type="checkbox" checked={onlyPrices} onChange={e=>setOnlyPrices(e.target.checked)}/>Solo con precio publicado</label>
    </div>
    <div className="market-comparison-scroll" tabIndex={0} aria-label="Tabla de ofertas">
      <table><thead><tr><th>Oferente / producto</th><th>Precio publicado · lectura seleccionada</th><th>Neto por unidad CLP</th><th>Diferencia vs. venta actual</th><th>Margen con costo {basis==='current'?'actual':'por llegar'}</th><th>Estado</th><th>Revision</th></tr></thead><tbody>
        <tr className="market-own-price"><th>Climactiva · {product.name}</th><td>{money(price===null?null:new Decimal(price).times('1.19').toNumber())}<small>Con IVA 19% calculado</small></td><td>{money(price)}</td><td>Referencia</td><td>{percent((basis==='current'?today:arrival).margin)}</td><td>{actual?'CRM / Facto':'Sin precio actual'}</td><td><a href={product.path}>Origen <ArrowUpRight size={14}/></a></td></tr>
        {rows.map(({offer:o,index,net,publishedNet,reviewed,savedReview})=><tr key={o.url}>
          <th>{o.image_url?<OfferImage key={o.image_url} url={o.image_url} title={o.title}/>:<small>Fuente sin foto verificable</small>}<a href={o.url} target="_blank" rel="noreferrer">{o.seller} <ArrowUpRight size={14}/></a><small>{o.title}</small><small>Leído {new Date(o.observed_at).toLocaleString('es-CL')}</small></th>
          <td>{o.currency?money(o.amount,o.currency):o.amount===null?'Sin precio verificable':`${o.amount} · moneda pendiente`}<small>{o.vat==='gross'?'IVA incluido':o.vat==='net'?'Neto sin IVA':'IVA por verificar'}{o.vat_assumed?' · 19% supuesto':''}</small>{o.currency_assumed&&<small>CLP supuesto</small>}{o.amount===null&&<small>{o.price_error||o.warning}</small>}</td>
          <td>{money(reviewed?net:publishedNet)}<small>{reviewed?'Por unidad interna · base revisada':net!==null?'Provisional':publishedNet!==null?'Referencia · no comparable':'Base no comparable'}{o.package_assumed?' · unidad supuesta':''}</small></td>
          <td>{net!==null&&price!==null?money(net-price):'Pendiente'}</td>
          <td>{percent(discountScenario(net,chosenCost,1,0,null,null).before.margin)}<small>Escenario provisional</small></td>
          <td><span>{o.availability==='available'?'Disponible':o.availability==='unavailable'?'Sin stock':'Stock por verificar'}</span><details><summary>{savedReview?savedReview.evidenceStatus==='reused'?'Equivalencia técnica conservada':savedReview.evidenceStatus==='reviewed'?'Equivalencia revisada':savedReview.evidenceStatus==='technical_changed'?'Cambio técnico · revisión requerida':savedReview.evidenceStatus==='technical_unverified'?'Verificación técnica pendiente':'Equivalencia histórica · precio pendiente':identityLabel[o.identity]}</summary>{savedReview&&<><p>Revisión humana de origen: {new Date(savedReview.review.created_at).toLocaleString('es-CL')}; evidencia aprobada: {new Date(savedReview.observation.payload.observed_at).toLocaleString('es-CL')}. Lectura comercial actual: {new Date(savedReview.effectivePayload.observed_at).toLocaleString('es-CL')}.</p>{savedReview.reusedTechnicalReview&&<p>Precio comercial actual: {money(savedReview.effectivePayload.amount,savedReview.effectivePayload.currency||'CLP')} · {new Date(savedReview.effectivePayload.observed_at).toLocaleString('es-CL')}. Identidad, atributos técnicos y presentación sin cambios verificables. Se conserva la revisión técnica; el precio, IVA y stock proceden de la nueva lectura.</p>}{savedReview.reasons.map(reason=><p key={reason}>{reason}</p>)}</>}{!savedReview&&<p>{o.warning}</p>}{o.match_reasons?.map((reason,i)=><p key={i}>{reason}</p>)}<small>{new Date(o.observed_at).toLocaleString('es-CL')}</small><pre>{o.evidence}</pre></details></td>
          <td><button className="secondary market-review-icon" title={`Revisar oferta de ${o.seller}`} aria-label={`Revisar oferta de ${o.seller}`} onClick={()=>onReview(index)}><Eye size={18}/></button></td>
        </tr>)}
      </tbody></table>
    </div>
    {offers.length>0&&<p role="status" className="market-muted">{offers.filter(o=>known(o.amount)).length} de {offers.length} fuentes con precio publicado</p>}
    {job?.state==='completed'&&offers.length===0&&<p role="status">La busqueda no encontro fichas publicas verificables para este producto.</p>}
    {offers.length>0&&rows.length===0&&<p role="status">Ninguna oferta coincide con los filtros.</p>}
    {job?.result.original_result&&<details className="market-muted"><summary>Resultado original conservado · {job.result.original_result.offers?.length||0} fuentes</summary><p>La actualización de fuentes .cl conserva la investigación anterior y no aprueba equivalencias.</p>{job.result.original_result.offers?.map((offer,index)=><p key={index}>{offer.title} · {offer.url} · {offer.observed_at} · {offer.amount===null?'Sin precio verificable':`${offer.amount} ${offer.currency||'moneda pendiente'}`} {offer.price_error||offer.warning}</p>)}</details>}
    {job&&<details className="market-muted"><summary>{offers.length} fuentes · Cobertura de la busqueda</summary><p>{job.result.coverage}</p>{job.result.queries?.map(q=><p key={q}>{q}</p>)}<p>{job.result.usage_note}</p></details>}
  </section>;
}

function ChannelSimulations({cost,source}:{cost:number|null;source?:string}) {
 return <section className="market-channel-section" aria-label="Simulación por canal"><h3>Costo de vender y margen por canal</h3><p>{source||'Sin costo puesto en bodega vinculado.'} · Costo utilizado: {money(cost)} por unidad. Verifica IVA recuperable y presentación. Los gastos siguientes son supuestos locales, no se guardan como tarifas ni cambian precios.</p><div className="market-channel-grid">{['Web','Distribuidor'].map(channel=><ChannelScenario key={channel} channel={channel} cost={cost}/>)}</div></section>;
}
function ChannelScenario({channel,cost}:{channel:string;cost:number|null}) {
 const [sale,setSale]=useState(''),[expenses,setExpenses]=useState(''),[commission,setCommission]=useState('');
 const num=(value:string)=>value.trim()===''?null:Number(value);
 const result=channelScenario(num(sale),cost,num(expenses),num(commission));
 return <fieldset><legend>{channel}</legend><label>Precio neto CLP · {channel}<input type="number" min="0" value={sale} onChange={e=>setSale(e.target.value)}/></label><label>Gastos CLP por unidad · {channel}<input type="number" min="0" value={expenses} onChange={e=>setExpenses(e.target.value)}/></label><label>Comisión % · {channel}<input type="number" min="0" max="99.99" value={commission} onChange={e=>setCommission(e.target.value)}/></label><p>Incluye en gastos envío a cargo vendedor, embalaje y otros gastos de venta conocidos. El precio distribuidor se ingresa independientemente: no se deriva del precio público.</p><p>Costo total: <strong>{money(result.totalCost)}</strong> · Contribución: <strong>{money(result.contribution)}</strong> · Margen: <strong>{percent(result.margin)}</strong></p>{result.reasons.map(reason=><p className="market-muted" key={reason}>{reason}</p>)}</fieldset>;
}

function OfferImage({url,title}:{url:string;title:string}) {
 const [failed,setFailed]=useState(false);
 return failed?<small>Foto no disponible; abre la ficha original.</small>:<img className="market-offer-image" src={url} alt={`Foto publicada: ${title}`} loading="lazy" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>;
}
