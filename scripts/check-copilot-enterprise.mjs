import assert from "node:assert/strict";
import { CopilotSources } from "../supabase/functions/crm-copilot/sources.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { runOrchestrator } from "../supabase/functions/crm-copilot/orchestrator.ts";
import { copilotConfig } from "../supabase/functions/crm-copilot/config.ts";
import { todayChile } from "../supabase/functions/crm-copilot/dates.ts";

// Private server-side stdin only. Never place credentials in arguments or output files.
let input = ""; for await (const chunk of process.stdin) input += chunk;
const settings = JSON.parse(input); input = "";
globalThis.Deno = { env: { get: key => settings.env[key] } };
const config = copilotConfig(key => settings.env[key]);
const allowedRpc = new Set(["accounting_dashboard_summary", "accounting_report", "accounting_income_statement", "foreign_trade_operation_detail", "foreign_trade_dashboard_summary"]);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const u = new URL(url), method = init.method || "GET";
  const model = u.origin === "https://api.openai.com" && u.pathname === "/v1/responses" && method === "POST";
  const readRpc = u.origin === new URL(settings.rest.url).origin && u.pathname.includes("/rest/v1/rpc/") && allowedRpc.has(u.pathname.split("/").at(-1));
  if (method !== "GET" && !model && !(method === "POST" && readRpc)) throw new Error("VALIDATION_WRITE_BLOCKED");
  return nativeFetch(url,init);
};
const make = signal => new CopilotSources(settings.rest, settings.actor, signal, globalThis.fetch, config.sourceTimeoutMs);
const source = make(AbortSignal.timeout(120000)), registry = new ToolRegistry(source);
const summary = await source.api("accounting-center", "summary");
const baseline = summary.dashboard;
const annual = await registry.execute("get_sales_summary", {period:"this_year"});
assert.ok(["ok","partial"].includes(annual.status), JSON.stringify(annual));
for (const row of annual.data.monthly) {
 const expected=baseline.monthly.find(m=>m.period===row.period);
 for(const key of ["sales","costs","expenses","operatingProfit","salesPendingDocuments","salesCostMissingDocuments","salesPriorCreditAdjustments"])
   assert.ok(Math.abs(Number(row[key])-Number(expected[key])) < .01, `Month ${row.period} ${key}: ${row[key]} / ${expected[key]}`);
}
const sales = await registry.execute("get_sales_summary", {period:"this_month"});
assert.equal(sales.toolName,"get_sales_summary");
assert.ok(["ok","partial"].includes(sales.status), JSON.stringify(sales));
const month = baseline.monthly.find(m => m.period === todayChile().slice(0,7));
for (const key of ["sales","costs","expenses","operatingProfit","grossMargin","salesPendingDocuments","salesCostMissingDocuments"]) {
  assert.ok(Math.abs(Number(sales.data.totals[key])-Number(month[key])) < .01, `${key}: copilot ${sales.data.totals[key]} / dashboard ${month[key]}`);
}
console.log(JSON.stringify({type:"baseline",at:new Date().toISOString(),model:config.model,totals:sales.data.totals,matchedDashboard:true,requests:source.metrics}));
for (const name of ["get_loans"]) {
 const result=await registry.execute(name,{});
 assert.ok(["ok","partial","empty"].includes(result.status),result.summary);
 console.log(JSON.stringify({type:"additional_read",toolName:name,status:result.status,returned:result.coverage.returned}));
}
const customers=await registry.execute("get_customer_sales",{period:"this_year",limit:1});
const customerId=customers.data?.records?.[0]?.id;
if (customerId && /^[a-f0-9-]{36}$/i.test(customerId)) {
 const profile=await registry.execute("get_customer_profile",{company_id:customerId});
 assert.equal(profile.status,"ok",profile.summary);
 console.log(JSON.stringify({type:"additional_read",toolName:"get_customer_profile",status:profile.status,contacts:profile.data.contacts.length}));
}
const cases = [
  ["Como va el negocio este mes?","generate_business_report",{period:"this_month"}],
  ["Cuanto vendimos el mes pasado?","get_sales_summary",{period:"last_month"}],
  ["Compara este mes con el anterior.","compare_sales_periods",{period:"this_month",compare_period:"last_month"}],
  ["Cuanto dinero nos deben los clientes?","get_accounts_receivable",{state:"pending"}],
  ["Muestrame los 10 clientes con mayor facturacion.","get_customer_sales",{period:"this_year",limit:10}],
  ["Que clientes importantes dejaron de comprar?","get_customer_sales",{period:"last_12_months",inactive_days:60,limit:10}],
  ["Cuales son los productos con stock critico?","search_products",{stock_filter:"low",threshold:10}],
  ["Cuales son los productos mas vendidos?","get_top_products",{period:"this_year"}],
  ["Que productos tienen mejor margen?","get_product_profitability",{sort_by:"margin_desc",limit:10}],
  ["Que mercaderia viene en camino?","get_imports",{state:"upcoming"}],
  ["Como va nuestra proxima importacion?","get_imports",{state:"upcoming",limit:1}],
  ["Genera un informe financiero del mes.","generate_business_report",{period:"this_month",focus:"financial"}],
  ["Genera un informe ejecutivo completo de la empresa.","generate_business_report",{period:"this_month",focus:"executive"}],
  ["Muestrame las ventas de los ultimos 12 meses en un grafico.","get_sales_summary",{period:"last_12_months",chart:"line"}],
  ["Que tenemos programado en el centro de contenido?","get_content",{view:"scheduled",period:"all"}],
];
for (let index=0;index<cases.length;index++) {
  if (settings.caseIndexes && !settings.caseIndexes.includes(index+1)) continue;
  const [question,tool,args]=cases[index], started=Date.now();
  const local = make(AbortSignal.timeout(config.timeoutMs)), tools = new ToolRegistry(local);
  try {
    const output = settings.useModel ? await runOrchestrator({registry:tools,model:config.model,apiKey:config.apiKey,reasoningEffort:config.reasoningEffort,maxOutputTokens:config.maxOutputTokens,message:question,history:[],signal:local.signal,onTrace:async()=>{}}) : {results:[await tools.execute(tool,args)]};
    console.log(JSON.stringify({type:"case",number:index+1,question,elapsedMs:Date.now()-started,metrics:local.metrics,...output}));
  } catch(error) { console.log(JSON.stringify({type:"case_error",number:index+1,error:error.name === "AbortError" ? "TIMEOUT" : String(error.message).slice(0,800)})); }
}
if (settings.contextTest) {
 const history=[];
 for(const question of ["Cuanto vendimos este mes?","Y el mes pasado?","Comparalos."]) {
  const local=make(AbortSignal.timeout(config.timeoutMs));
  const output=await runOrchestrator({registry:new ToolRegistry(local),model:config.model,apiKey:config.apiKey,reasoningEffort:config.reasoningEffort,maxOutputTokens:config.maxOutputTokens,message:question,history,signal:local.signal,onTrace:async()=>{}});
  console.log(JSON.stringify({type:"context",question,...output}));
  history.push({role:"user",content:question},{role:"assistant",content:output.message});
 }
}
