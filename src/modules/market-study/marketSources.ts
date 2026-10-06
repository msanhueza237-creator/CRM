import type { MarketBootstrap } from '../../lib/marketStudyApi';
import type { ForeignTradeCostingSettings, ForeignTradeAllocationMethod } from '../foreign-trade/foreignTradeCostEngine.ts';
import { calculateForeignTradeCosting } from '../foreign-trade/foreignTradeCostEngine.ts';
import type { MarketProduct } from './marketMath.ts';
import { known, fresh, MARKET_RULES } from './marketMath.ts';
import { publicProductDescription } from '../../../supabase/functions/_shared/market-product-search.ts';
export function marketProducts(data:MarketBootstrap):MarketProduct[]{
 const current:MarketProduct[]=data.inventory.map(p=>({key:`current:${p.sku}`,sku:p.sku,name:p.name,description:publicProductDescription(p.description),brand:publicProductDescription(p.brand,120),mode:'current',stock:known(p.stock)?p.stock:null,stockAt:p.stock_updated_at,eta:null,
  price:p.net_price,priceCurrency:p.price_currency,priceAt:p.price_updated_at,cost:p.unit_cost??null,costCurrency:p.cost_currency??null,costAt:p.cost_updated_at??null,
  costStatus:p.unit_cost!=null&&p.cost_currency?'recorded':'missing',costCurrencyAssumed:!p.cost_currency&&p.assumed_cost_currency==='CLP',costSource:'Facto: costo de producto registrado; no costo histórico de una venta.',path:`/dashboard?inventory_query=${encodeURIComponent(p.sku)}#inventario`,notices:[...(p.stock_warnings||[]),...(!p.cost_currency&&p.assumed_cost_currency==='CLP'?['Costo con moneda pendiente: simulacion en CLP segun moneda de venta; no confirmado.']:[])]}));
 const incoming:MarketProduct[]=[];
 for(const detail of data.imports){
  const op=detail.operation;if(op.inventory_mode!=='future'||['received','closed','cancelled'].includes(op.status))continue;
  const baseline=detail.scenarios.filter(s=>s.status==='baseline');const scenario=baseline.length===1?baseline[0]:null;
  const at=(data.readAt||new Date().toISOString()).slice(0,10);
  const parameter=(code:string)=>{const candidates=(data.costParameters||[]).filter(p=>p.active&&p.code===code&&(!p.valid_from||p.valid_from<=at)&&(!p.valid_until||p.valid_until>=at));return candidates.length===1?candidates[0].numeric_value:null;};
  const saved=scenario?.assumptions.costing;
  const c=saved||(scenario?{general_duty_percent:parameter('cl_general_ad_valorem'),import_vat_percent:parameter('cl_import_vat'),sales_vat_percent:parameter('cl_sales_vat'),import_vat_recoverable:true,cif_total_original:null,line_duty_percent:{}}:null);
  const issues:string[]=[];
  if(!scenario||!c)issues.push('Sin escenario base único con supuestos de costo.');
  let calculation:ReturnType<typeof calculateForeignTradeCosting>|null=null;
  if(scenario&&c){
   if(!saved)issues.push('Simulacion no guardada: parametros vigentes de Comercio Exterior; IVA de importacion recuperable supuesto. Gastos sujetos a cierre.');
   if(detail.costs.some(c=>c.source_type==='simulated'))issues.push('Incluye gastos simulados, no liquidacion final de la importacion.');
   const allocations:ForeignTradeAllocationMethod[]=['fob_value','cif_value','units','weight','cbm','combined'];
   const complete=detail.lines.every(l=>['CLP',op.base_currency].includes(l.currency)&&known(l.quantity)&&l.quantity>0) && detail.costs.filter(c=>!c.metadata?.excluded_from_costing).every(c=>known(c.amount_clp)) && [c.general_duty_percent,c.import_vat_percent,c.sales_vat_percent].every(v=>known(v)&&v<=100) && known(scenario.exchange_rate_clp)&&scenario.exchange_rate_clp>0&&known(c.general_duty_percent)&&known(c.import_vat_percent)&&known(c.sales_vat_percent)&&typeof c.import_vat_recoverable==='boolean'&&allocations.includes(scenario.allocation_method as ForeignTradeAllocationMethod);
   if(!complete)issues.push('Tipo de cambio, impuestos o prorrateo sin datos explícitos.');
   else{
    const settings:ForeignTradeCostingSettings={exchangeRateClp:scenario.exchange_rate_clp,cifOverrideOriginal:c.cif_total_original??null,generalDutyPercent:c.general_duty_percent!,importVatPercent:c.import_vat_percent!,salesVatPercent:c.sales_vat_percent!,importVatRecoverable:c.import_vat_recoverable!,pricingMethod:'margin_on_sale',targetPercent:0,allocationMethod:scenario.allocation_method as ForeignTradeAllocationMethod,lineDutyPercent:c.line_duty_percent||{},lineTargetPercent:{}};
    calculation=calculateForeignTradeCosting(detail.lines,detail.costs,settings);issues.push(...calculation.missingInputs,...scenario.missing_inputs);
   }
   if(!scenario.calculated_at||Date.parse(op.updated_at)>Date.parse(scenario.calculated_at))issues.push('Escenario anterior a la última modificación de la operación o sin fecha.');
   // This timestamp is optional evidence from the saved scenario; never substitute its creation date.
   if(typeof scenario.assumptions.fx_observed_at!=='string'||!fresh(scenario.assumptions.fx_observed_at,MARKET_RULES.fxDays)||!scenario.exchange_rate_source)issues.push('Fecha de origen del tipo de cambio no registrada: estimación pendiente de revisar.');
  }
  for(const line of detail.lines){
   const code=(v:string|null|undefined)=>(v||'').trim().toUpperCase();
   const codes=line.sku?[code(line.sku)]:[code(line.supplier_sku),code(line.supplier_model)].filter(Boolean);
   const exact=current.filter(p=>codes.includes(code(p.sku)));
   const repeated=!line.sku&&exact.length===1&&detail.lines.filter(l=>[code(l.sku),code(l.supplier_sku),code(l.supplier_model)].includes(code(exact[0].sku))).length>1;
   const priced=exact.length===1&&!repeated?exact[0]:null;
   const ambiguous=exact.length>1||repeated;
   const result=calculation && !calculation.missingInputs.length && !scenario?.missing_inputs.length ? calculation.lines.find(r=>r.lineId===line.id) : undefined;
   incoming.push({key:`transit:${op.id}:${line.id}`,sku:priced?.sku||line.sku||line.supplier_sku||line.supplier_model||'',relatedCurrentSku:priced?.sku??null,name:line.product_name,description:publicProductDescription(line.description)||priced?.description,brand:priced?.brand,mode:'transit',stock:known(line.quantity)?line.quantity:null,stockAt:op.updated_at,eta:op.estimated_arrival,
    price:priced?.price??null,priceCurrency:priced?.priceCurrency??null,priceAt:priced?.priceAt??null,cost:result&&line.quantity>0?result.landedUnitClp:null,costCurrency:result?'CLP':null,costAt:scenario?.calculated_at??null,costStatus:result?'estimated':'missing',
    costSource:scenario?`Comercio Exterior · ${op.reference} · escenario ${scenario.name} · TC ${scenario.exchange_rate_clp} CLP/${op.base_currency}; fuente ${scenario.exchange_rate_source}; fecha TC ${String(scenario.assumptions.fx_observed_at||'no registrada')}; calculado ${scenario.calculated_at||'sin fecha'}`:`Comercio Exterior · ${op.reference} · sin costo puesto en Chile`,
    path:`/comercio-exterior?view=operations&operation=${encodeURIComponent(op.id)}`,notices:[...new Set([...issues,...(!line.sku?[priced?'Coincidencia exacta de codigo proveedor/modelo; vinculo interno pendiente.':ambiguous?'Codigo proveedor ambiguo: no vinculado a un producto actual.':'Sin vinculo exacto con un SKU del inventario actual.']:[]),...(!known(line.quantity)||line.quantity<=0?['Cantidad pendiente.']:[])])]});
  }
 }
 return [...current,...incoming];
}
