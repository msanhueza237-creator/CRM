import { object, rows, numeric, readResult, type Row, type ReadResult } from "./contracts.ts";
import { todayChile } from "./dates.ts";
import { comparablePurchaseWindows } from "./customer-purchase-signals.ts";
type Run = (name: string, args: Row) => Promise<ReadResult>;
const skuKey = (value: unknown) => String(value || "").trim().toUpperCase();
const fresh = (value: unknown, now: number) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now && now - Date.parse(value) <= 86400000;
export function stockCoverageScenario(stock: Row | undefined, sales: Row[], range: {from:string;to:string}, complete: boolean, now=Date.now()) {
  const sku = skuKey(stock?.sku), matching = sales.filter(r => sku && skuKey(r.sku) === sku);
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  const quantity = numeric(stock?.stock), sale = matching.length === 1 ? matching[0] : undefined;
  const units = numeric(sale?.units_sold), documents = numeric(sale?.document_count);
  let missing: string | null = !stock ? "Confirmar un SKU único; la búsqueda no identifica un solo producto exacto." : quantity === null || stock.stock_known !== true ? "Cantidad de stock desconocida; no equivale a cero." : quantity < 0 || !stock.stock_source ? "Stock negativo o sin fuente identificada: requiere revisión." : !fresh(stock.stock_updated_at,now) ? "Stock sin fecha reciente (máximo 24 horas); verificar existencias." : null;
  if (!missing && Array.isArray(stock?.stock_warnings) && stock.stock_warnings.length) missing="Stock con advertencias de origen/consistencia: verificar antes de proyectar.";
  if (!missing && !complete) missing="Cobertura de ventas/stock incompleta, notas o líneas pendientes: revisar antes de estimar velocidad.";
  if (!missing && matching.length !== 1) missing="No hay una serie documental única para el SKU (ausente, duplicada o dividida por moneda).";
  if (!missing && (units === null || units <= 0 || documents === null || documents < 3 || !Number.isFinite(days) || days < 7)) missing="Se requieren unidades positivas, al menos tres documentos y siete días completos; no se inventa demanda.";
  const dailyUnits = !missing ? units! / days : null;
  const coverageDays = dailyUnits !== null && quantity !== null ? Math.max(0,Math.round(quantity / dailyUnits * 10)/10) : null;
  return {sku:sku||null,stock:quantity,stockSource:stock?.stock_source||null,stockObservedAt:stock?.stock_updated_at||null,
    salesPeriod:range,unitsInPeriod:units,documents,dailyInvoicedUnits:dailyUnits,conditionalCoverageDays:coverageDays,missing,
    reservations:null,physicalDepletionDate:null,confidence:coverageDays===null?"no estimable":"baja",
    assumptions:["Unidades facturadas son un indicador, no consumo físico; validar que SKU y unidad/embalaje sean equivalentes.","Reservas, pedidos comprometidos, mermas y movimientos futuros no están cubiertos. No se restan reservas inventadas.","Supone ritmo diario constante del período observado, sin estacionalidad. La cobertura no es una fecha asegurada de quiebre."],
    action:missing?"Verificar stock, detalle de ventas y pendientes en Logística/Finanzas.":"Contrastar stock físico, reservas y unidad de venta; revisar reposición antes de comprometer entregas.",path:"/agentes/logistics/dashboard"};
}
export function incomingForSku(detail: ReadResult, sku: string, today: string, coverageDays: number | null, now=Date.now()) {
  const data=object(detail.data),operation=object(data.operation),matching=rows(data.lines).filter(l=>skuKey(l.sku)===skuKey(sku));
  const identities=new Set<string>();let duplicate=false;
  for(const l of matching){const id=String(l.id||"");if(!id||identities.has(id))duplicate=true;identities.add(id);}
  const quantities=matching.map(l=>numeric(l.quantity));
  const usable=detail.status==="ok"&&detail.coverage.complete&&detail.coverage.returned===(detail.coverage.totalMatched??detail.coverage.returned)&&!duplicate&&matching.length>0&&quantities.every(q=>q!==null&&q>0)&&!["received","closed","cancelled"].includes(String(operation.status));
  const eta=typeof operation.estimated_arrival==="string"?operation.estimated_arrival:null;
  const date=eta?.slice(0,10),validDate=!!date&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
  const days=validDate?Math.round((Date.parse(date!)-Date.parse(today))/86400000):null;
  const comparison=!fresh(detail.freshness.sourceObservedAt,now)?"Importación sin actualización reciente; confirmar cantidad y ETA antes de comparar." : !usable?"Cantidad o identidad/cobertura pendiente; no acredita reposición." : days===null?"Sin ETA válida; no se puede comparar llegada." : days<0?"ETA vencida; confirmar nueva fecha y recepción." : coverageDays===null?"ETA estimada disponible, pero cobertura de stock no calculable." : coverageDays<days?"Escenario: cobertura menor que días hasta ETA; revisar reposición/fecha." : "Escenario: cobertura alcanza la ETA estimada; no garantiza disponibilidad ni recepción.";
  return {operationId:operation.id||null,title:operation.title||null,status:operation.status||null,sku,matchedLines:matching.length,
    plannedQuantity:usable?quantities.reduce<number>((n,q)=>n+q!,0):null,estimatedArrival:eta,daysUntilEstimatedArrival:days,
    sourceObservedAt:detail.freshness.sourceObservedAt,comparison,path:`/comercio-exterior?view=operations&operation=${encodeURIComponent(String(operation.id||""))}`};
}
export async function stockOutlookTool(run: Run, args: Row, importsAllowed: boolean, now=new Date()) {
  const query=String(args.query||"").trim(),today=todayChile(now),range=comparablePurchaseWindows(today,Number(args.days||30)).current;
  if(!query)return readResult("get_stock_outlook","sales","Indica el SKU para cruzar stock, ventas e importaciones sin unir productos ambiguos.",null,[],{status:"needs_clarification"});
  const stocks=await run("search_products",{query,stock_filter:"all",result_scope:"all_matches",limit:100});
  if(!["ok","partial","empty"].includes(stocks.status)) return readResult("get_stock_outlook","sales",`No se pudo consultar stock (${stocks.status}). Reintenta la lectura o revisa el acceso a la fuente; no se interpreta como cero ni como SKU inexistente.`,{sourceStatus:stocks.status},stocks.evidence,{status:stocks.status==="forbidden"?"forbidden":"unavailable",coverage:{complete:false,totalMatched:null,returned:0}});
  const candidates=rows(object(stocks.data).records).filter(r=>skuKey(r.sku)===skuKey(query));
  if(candidates.length!==1||!["ok","partial"].includes(stocks.status))return readResult("get_stock_outlook","sales","La búsqueda no confirmó un SKU exacto único. Selecciona el SKU desde Logística; no se calcula velocidad ni quiebre.",{candidates:rows(object(stocks.data).records).map(r=>({sku:r.sku,name:r.name})),sourceStatus:stocks.status},stocks.evidence,{status:"needs_clarification",coverage:{complete:false,totalMatched:candidates.length,returned:candidates.length}});
  const sales=await run("get_top_products",{query:candidates[0].sku,period:"custom",from:range.from,to:range.to,metric:"units",result_scope:"all_matches",group_by:"product",detail_level:"summary",identity_scope:"catalog",limit:100});
  const actual=object(object(sales.data).period);
  const salesCurrent=fresh(sales.freshness.sourceObservedAt,now.getTime());
  const scenario=stockCoverageScenario(candidates[0],rows(object(sales.data).records),range,salesCurrent&&stocks.status==="ok"&&stocks.coverage.complete&&sales.status==="ok"&&sales.coverage.complete&&actual.from===range.from&&actual.to===range.to,now.getTime());
  if(!["ok","partial","empty"].includes(sales.status)) scenario.missing=`Ventas no disponibles (${sales.status}); no se calcula velocidad ni cobertura.`;
  else if(!salesCurrent) scenario.missing="Ventas sin fecha de observación reciente: verificar cobertura/actualización antes de estimar velocidad.";
  const incoming: ReturnType<typeof incomingForSku>[]=[];
  let importsScope=importsAllowed?"Hasta cinco próximas operaciones, sin afirmar cobertura total.":"Comercio Exterior no consultado: el perfil no tiene permiso.";
  const evidence=[...stocks.evidence,...sales.evidence];
  if(importsAllowed){
    const list=args.operation_id?null:await run("get_imports",{state:"upcoming",limit:5,offset:0});
    const ids=args.operation_id?[String(args.operation_id)]:list&&["ok","empty"].includes(list.status)?rows(object(list.data).records).map(r=>String(r.id)):[];
    importsScope=args.operation_id?"Solo la operación solicitada.":list?`Importaciones: ${list.coverage.returned}/${list.coverage.totalMatched??"total desconocido"} operaciones; estado ${list.status}. No se infiere ausencia fuera de esta cobertura.`:importsScope;
    if(list)evidence.push(...list.evidence);
    for(const id of [...new Set(ids)].slice(0,5)){
      const detail=await run("get_import_details",{operation_id:id,limit:100,offset:0});
      if(!["ok","empty","partial"].includes(detail.status)){importsScope+=` Detalle no disponible (${detail.status}); no se acredita reposición.`;continue;}
      const item=incomingForSku(detail,String(candidates[0].sku),today,scenario.conditionalCoverageDays,now.getTime());
      if(item.matchedLines) incoming.push(item);
      else if(detail.coverage.returned!==(detail.coverage.totalMatched??detail.coverage.returned))importsScope+=" Detalle de líneas parcial: no se descartan coincidencias fuera de la página.";
      evidence.push(...detail.evidence);
    }
  }
  const summary=scenario.missing||`Escenario condicionado para ${scenario.sku}: ${scenario.conditionalCoverageDays} días de cobertura al ritmo de ${scenario.dailyInvoicedUnits?.toFixed(2)} unidades facturadas/día. Confianza baja; no es fecha de quiebre.`;
  const result=readResult("get_stock_outlook","sales",`${summary} Stock observado ${scenario.stockObservedAt||"sin fecha"}; ventas ${range.from} a ${range.to}. ${scenario.assumptions.join(" ")} ${importsScope} ${incoming.map(i=>i.comparison).join(" ")} Acción: ${scenario.action}`,
    {scenario,salesObservedAt:sales.freshness.sourceObservedAt,incoming,importsScope,generatedAt:now.toISOString(),horizon:"Cobertura condicional y comparación con ETA, sin sumar importaciones al stock disponible"},evidence,
    {status:"partial",warnings:[...scenario.assumptions,"Cantidades en tránsito son planificadas, no stock disponible. ETA no garantiza llegada, aduana ni disponibilidad para venta."],coverage:{complete:false,totalMatched:1,returned:1}});
  result.freshness.sourceObservedAt=typeof scenario.stockObservedAt==="string"?scenario.stockObservedAt:null;
  result.table={title:"Reposición planificada del SKU — no stock disponible",columns:[{key:"title",label:"Operación"},{key:"plannedQuantity",label:"Unidades planificadas"},{key:"estimatedArrival",label:"ETA estimada"},{key:"comparison",label:"Revisión recomendada"}],rows:incoming};
  return result;
}

export function canonicalOperationalOutlookMessage(results: ReadResult[]): string | null {
  return results.length === 1 && ["get_stock_outlook", "get_customer_purchase_signals"].includes(results[0].toolName)
    && ["partial", "needs_clarification", "unavailable", "forbidden"].includes(results[0].status) ? results[0].summary : null;
}
