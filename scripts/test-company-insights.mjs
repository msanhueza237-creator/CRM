import test from "node:test";
import assert from "node:assert/strict";
import { invoiceCustomers, customerClassificationPlan, validCustomerTaxId, newInvoiceCustomer } from "../supabase/functions/_shared/invoice-customers.ts";
import { applyCustomerClassification, readCustomerClassification } from "../supabase/functions/crm-copilot/company-evidence.ts";
import { ToolRegistry } from "../supabase/functions/crm-copilot/tool-registry.ts";
import { specialists } from "../supabase/functions/crm-copilot/agent-manager.ts";
import { classifyInvoiceCustomers } from "../supabase/functions/crm-agent/invoice-customer-classification.ts";
import { customerProfitabilityTool } from "../supabase/functions/crm-copilot/customer-profitability.ts";
import { customerProfitability } from "../supabase/functions/accounting-center/customer-profitability.ts";
import { CopilotSources } from "../supabase/functions/crm-copilot/sources.ts";
import { centralHandler } from "../supabase/functions/crm-copilot/central.ts";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const company = { id, name: "Empresa Uno", rut: "76.919.986-1", status: "prospecto", type: "distribuidor", whatsapp_opt_in: false, updated_at: "2026-09-01T00:00:00Z" };
const doc = (key, overrides={}) => ({ id: key, entity_id: "entity", document_type: "sales_invoice", issued_on: "2026-01-10", counterpart_tax_id: "76919986-1", counterpart_name: "Empresa Uno", status: "validated", data_quality: "validated", ...overrides });
const raw = (key, tax="76919986-1", type="33", currency="39") => ({ external_id:String(key), header: { document_id: String(key), received_issued_flag:"1", document_type_taxbureau:type, document_status:"1", issue_date:"2026-01-10", document_number:String(key), issuer_tax_id_code:"76500000-1", receiver_tax_id_code:tax, receiver_legal_name:"Empresa Uno", currency_id:currency, net_amount:200 } });
const detail = d => ({ ...d, details: [{ line_description:"Difusor",quantity:2,unit_price:100 }], totals:{net_amount:200} });
function source({ companies=[company], documents=[doc("a")], rawDocuments=[raw(1),raw(2,"76500000-2"),raw(3,"76919986-1","61")], rawDetails, role="administrador" }={}) {
  const calls=[];
  return { calls, actor:{role,id:otherId},
    invalidateCache(){},
    entity: async()=>"entity",
    select: async path => { calls.push(path);
      if(path.startsWith("companies?")) return companies.filter(c=>path.includes(`id=eq.${c.id}`));
      if(path.startsWith("accounting_entities?")) return [{tax_id:"76500000-1"}];
      return [];
    },
    all: async path => { calls.push(path);
      if(path.startsWith("companies?")) return companies;
      if(path.startsWith("accounting_source_documents?")) return documents;
      if(path.includes("resource=eq.documents")) return rawDocuments;
      if(path.includes("resource=eq.document_details")) return rawDetails || rawDocuments.map(detail);
      if(path.startsWith("content_products?")) return [{id:"p",sku:"D-1",name:"Difusor"}];
      return [];
    }, records:async()=>[],
    request: async(path, init, user)=> { calls.push({path,init,user}); return path.includes("companies?") ? [{id:JSON.parse(init.body).id || id,status:"cliente"}] : []; },
  };
}

test("Cliente requiere factura vigente identificada de la entidad; no guia, NC, compra ni futuro",()=>{
  const valid=doc("ok");
  const invalid=["sales_dispatch_guide","sales_credit_note","purchase_invoice","sales_receipt"].map((type,i)=>doc(`bad-${i}`,{document_type:type}));
  invalid.push(doc("void",{status:"cancelled"}),doc("quality",{data_quality:"pending"}),doc("foreign",{entity_id:"other"}),doc("missing",{counterpart_tax_id:""}),doc("future",{issued_on:"2027-01-01"}),doc("date",{issued_on:"2026-02-30"}));
  const result=invoiceCustomers([valid,valid,...invalid],"entity","2026-09-30");
  assert.equal(result.length,1); assert.deepEqual(result[0].documents,["ok"]);
});

test("Productos de empresa: mayor importe por defecto, unidades opcionales y paginacion posterior al orden", async()=>{
  const invoice=raw(1); invoice.header.net_amount=1100;
  const invoiceDetail={...invoice,totals:{net_amount:1100},details:[
    {line_description:"Mucho volumen",quantity:100,unit_price:1},
    {line_description:"Mayor venta",quantity:2,unit_price:500},
  ]};
  const registry=new ToolRegistry(source({rawDocuments:[invoice],rawDetails:[invoiceDetail]}));
  const amount=await registry.execute("get_customer_products",{company_id:id,period:"this_year",limit:1});
  assert.equal(amount.table.rows[0].name,"Mayor venta"); assert.equal(amount.table.rows[0].net_sales,1000);
  assert.equal(amount.table.rows[0].average_net_unit_price,500);
  const units=await registry.execute("get_customer_products",{company_id:id,period:"this_year",metric:"units",limit:1});
  assert.equal(units.table.rows[0].name,"Mucho volumen");
  const next=await registry.execute("get_customer_products",{company_id:id,period:"this_year",limit:1,offset:1});
  assert.equal(next.table.rows[0].name,"Mucho volumen");
});
test("Historial incluye anos previos y no degrada clientes por ausencia de facturas recientes",()=>{
  const result=invoiceCustomers([doc("old",{issued_on:"2025-01-02"}),doc("new")],"entity","2026-09-30");
  assert.equal(result[0].firstPurchase,"2025-01-02"); assert.equal(result[0].lastPurchase,"2026-01-10");
  const plan=customerClassificationPlan([{...company,status:"cliente"}],[doc("old")],"entity","2026-09-30");
  assert.equal(plan[0].action,"unchanged");
});
test("No une por nombre, fusiona duplicados ni crea fichas sin identidad unica",()=>{
  const input=[doc("one")];
  assert.equal(customerClassificationPlan([{...company,rut:"76500000-2"}],input,"entity","2026-09-30")[0].action,"ambiguous");
  assert.equal(customerClassificationPlan([company,{...company,id:otherId,rut:"769199861"}],input,"entity","2026-09-30")[0].action,"ambiguous");
  assert.equal(customerClassificationPlan([company],input,"entity","2026-09-30")[0].action,"classify");
});
test("Nueva ficha requiere RUT con digito verificador y usa identidad idempotente sin inventar contactos",async()=>{
  assert.equal(validCustomerTaxId("76.919.986-1"),true); assert.equal(validCustomerTaxId("76.919.986-2"),false);
  assert.equal(customerClassificationPlan([], [doc("a")], "entity", "2026-09-30")[0].action,"create");
  assert.equal(customerClassificationPlan([], [doc("a",{counterpart_tax_id:"76919986-2"})], "entity", "2026-09-30")[0].action,"unlinked");
  const a=await newInvoiceCustomer("entity","769199861","Empresa Uno");
  assert.deepEqual(a,await newInvoiceCustomer("entity","76.919.986-1","Empresa Uno"));
  assert.equal(a.whatsapp_opt_in,false); assert.equal(a.email,undefined); assert.equal(a.status,"cliente");
});
test("Crear fichas necesita confirmacion especifica y nunca sobrescribe una identidad existente",async()=>{
  const s=source({companies:[]}), p=await readCustomerClassification(s);
  assert.equal((await applyCustomerClassification(s,p.fingerprint,"t")).created.length,0);
  const s2=source({companies:[]}), p2=await readCustomerClassification(s2);
  assert.equal((await applyCustomerClassification(s2,p2.fingerprint,"t",true)).created.length,1);
  const request=s2.calls.find(c=>c.init && c.path.startsWith("rest/v1/companies?"));
  assert.equal(request.init.headers.Prefer,"resolution=ignore-duplicates,return=representation");
  assert.equal(request.user,true); assert.deepEqual(Object.keys(JSON.parse(request.init.body)).sort(),["id","legal_name","name","priority","rut","source","status","type","whatsapp_opt_in","whatsapp_status"].sort());
});
test("Aplicacion administrativa revalida lote y cambia solo status con control de concurrencia",async()=>{
  const s=source(), preview=await readCustomerClassification(s);
  await assert.rejects(applyCustomerClassification(s,"stale","trace"),/evidencia cambio/);
  assert.equal(s.calls.filter(c=>c.init).length,0);
  const result=await applyCustomerClassification(s,preview.fingerprint,"trace");
  assert.deepEqual(result.applied,[id]);
  const patch=s.calls.find(c=>c.init?.method==="PATCH");
  assert.deepEqual(JSON.parse(patch.init.body),{status:"cliente"}); assert.equal(patch.user,true);
  assert.match(patch.path,/status=eq.prospecto&updated_at=eq./);
  assert.equal(s.calls.filter(c=>c.init?.method==="POST").length,2);
});
test("Rol sin autorizacion no reclasifica; conflicto no se cuenta como aplicado",async()=>{
  const denied=source({role:"vendedor"});
  await assert.rejects(applyCustomerClassification(denied,"x","t"),/Solo administracion/); assert.equal(denied.calls.length,0);
  const s=source(), p=await readCustomerClassification(s); s.request=async()=>[];
  const result=await applyCustomerClassification(s,p.fingerprint,"t"); assert.equal(result.applied.length,0); assert.deepEqual(result.conflicts,[id]);
});
test("Cambio de identidad durante el lote se retiene antes de escribir",async()=>{
  const s=source(), p=await readCustomerClassification(s), original=s.all;
  let reads=0;
  s.all=async path=>path.startsWith("companies?") && ++reads>1 ? [company,{...company,id:otherId}] : original(path);
  const result=await applyCustomerClassification(s,p.fingerprint,"t");
  assert.equal(result.applied.length,0); assert.equal(result.conflicts.length,1);
  assert.equal(s.calls.filter(c=>c.init?.method==="PATCH").length,0);
});
test("Revalidacion descarta cache de lectura anterior antes de modificar una ficha",async()=>{
  let requests=0;
  const s=new CopilotSources({url:"https://fixture.invalid",serviceRoleKey:"test",anonKey:"test"},{id,role:"administrador",accessToken:"test"},undefined,
    async()=>new Response(JSON.stringify([{id,version:++requests}]),{headers:{"content-range":"0-0/1"}}));
  assert.equal((await s.all("companies?select=id"))[0].version,1);
  assert.equal((await s.all("companies?select=id"))[0].version,1);
  s.invalidateCache(); assert.equal((await s.all("companies?select=id"))[0].version,2);
});
test("Rutas nuevas conservan permisos y exigen confirmacion sin llamadas a modelos",async()=>{
  const savedFetch=globalThis.fetch;
  globalThis.fetch=async()=>assert.fail("La solicitud rechazada no debe acceder a datos ni modelos");
  const config={url:"https://fixture.invalid",serviceRoleKey:"test",anonKey:"test"};
  const actor={id,role:"administrador",accessToken:"test"};
  const request=(route,method="GET",body)=>new Request(`https://fixture.invalid/functions/v1/crm-copilot/${route}`,{method,...(body?{body:JSON.stringify(body)}:{})});
  try {
    assert.equal((await centralHandler(request("customer-classification"),config,{...actor,role:"vendedor"},"t",{})).status,403);
    assert.equal((await centralHandler(request("customer-classification","POST",{fingerprint:"a".repeat(64)}),config,actor,"t",{})).status,400);
    assert.equal((await centralHandler(request("company-insights","POST",{}),config,actor,"t",{})).status,405);
  } finally {globalThis.fetch=savedFetch;}
});

function integrationDb({companies=[company],documents=[doc("a")],conflict=false,auditError=false}={}) {
  const writes=[];
  return {writes,from(table){
    let update,insert;
    const chain={
      select(){return chain;}, eq(){return chain;}, in(){return chain;}, is(){return chain;}, order(){return chain;}, range(){return chain;},limit(){return chain;},
      update(data){update=data;writes.push({table,data,method:"update"});return chain;},
      insert(data){insert=data;writes.push({table,data,method:"insert"});return chain;},
      then(resolve,reject){const data=table==="accounting_entities"?[{id:"entity"}]:table==="accounting_source_documents"?documents:table==="companies"?(update?(conflict?[]:[{id,status:"cliente"}]):companies):[];
        return Promise.resolve({data,error:insert&&auditError?{message:"audit blocked"}:null}).then(resolve,reject);}
    };return chain;
  }};
}
test("Sincronizacion clasifica existentes, no crea perfiles ni modifica consentimiento",async()=>{
  const db=integrationDb(), result=await classifyInvoiceCustomers(db,["1"],"trace");
  assert.deepEqual(result.classified,[id]);
  assert.deepEqual(db.writes.filter(w=>w.table==="companies"),[{table:"companies",data:{status:"cliente"},method:"update"}]);
  assert.equal(db.writes.filter(w=>w.table==="copilot_audit_events").length,2);
  const missing=integrationDb({companies:[]}), pending=await classifyInvoiceCustomers(missing,["1"],"trace");
  assert.equal(pending.unresolved,1); assert.equal(missing.writes.length,0);
});
test("Sincronizacion retiene duplicados y falla antes de cambiar si falta auditoria",async()=>{
  const duplicate=integrationDb({companies:[company,{...company,id:otherId}]});
  assert.equal((await classifyInvoiceCustomers(duplicate,["1"],"t")).unresolved,1); assert.equal(duplicate.writes.length,0);
  const denied=integrationDb({auditError:true});
  await assert.rejects(classifyInvoiceCustomers(denied,["1"],"t"),/respaldar/);
  assert.equal(denied.writes.filter(w=>w.method==="update").length,0);
  const conflict=await classifyInvoiceCustomers(integrationDb({conflict:true}),["1"],"t");
  assert.deepEqual(conflict.classified,[]); assert.deepEqual(conflict.conflicts,[id]);
});
test("Productos se atribuyen solo al RUT exacto y al emisor contable, con notas pendientes",async()=>{
  const s=source(); const r=await new ToolRegistry(s).execute("get_customer_products",{company_id:id,period:"this_year",currency:"CLP",limit:10});
  assert.equal(r.status,"partial"); assert.equal(r.table.rows.length,1); assert.equal(r.table.rows[0].units_sold,2);
  assert.equal(r.table.rows[0].net_sales,200); assert.equal(r.data.company.id,id);
  assert.equal(r.data.document_coverage.problems.length,1);
  assert.ok(s.calls.some(c=>typeof c==="string"&&c.includes("external_id=in.(1,3)")));
});
test("Separacion de monedas, importe desconocido y periodo no inventan ceros",async()=>{
  const a=raw(1), b=raw(2,"76919986-1","33","5");
  const r=await new ToolRegistry(source({rawDocuments:[a,b]})).execute("get_customer_products",{company_id:id,period:"this_year",currency:"USD"});
  assert.equal(r.table.rows.length,1); assert.equal(r.table.rows[0].currency,"USD"); assert.equal(r.table.rows[0].units_sold,2);
  const incomplete=await new ToolRegistry(source({rawDocuments:[a],rawDetails:[]})).execute("get_customer_products",{company_id:id,period:"this_year"});
  assert.equal(incomplete.status,"partial"); assert.equal(incomplete.table.rows.length,0);
});
test("Falta o contradiccion de emisor nunca produce ventas atribuidas a otra empresa",async()=>{
  const a=raw(1); delete a.header.issuer_tax_id_code;
  const missing=await new ToolRegistry(source({rawDocuments:[a]})).execute("get_customer_products",{company_id:id,period:"this_year"});
  assert.equal(missing.status,"unavailable"); assert.equal(missing.data,null);
  const invoice=raw(1), bad={...detail(invoice),header:{...invoice.header,issuer_tax_id_code:"other"}};
  const mismatch=await new ToolRegistry(source({rawDocuments:[invoice],rawDetails:[bad]})).execute("get_customer_products",{company_id:id,period:"this_year"});
  assert.equal(mismatch.status,"partial"); assert.equal(mismatch.table.rows.length,0);
});
test("Rentabilidad exige confirmacion del ID/RUT exactos del backend durante despliegue mixto",async()=>{
  const report=customerProfitability([],[],[],"2026-01-01","2026-09-30","",1,0);
  let called=""; const s=source(); s.api=async(_,path)=>{called=path;return report;};
  const args={company_id:id,period:"this_year",sort_by:"sales",limit:1};
  await assert.rejects(customerProfitabilityTool(s,args),/identidad/);
  assert.match(called,new RegExp(`companyId=${id}`));
  s.api=async()=>({...report,companyId:id,companyTaxId:"769199861"});
  assert.equal((await customerProfitabilityTool(s,args)).data.ranking.length,0);
  s.api=async()=>({...report,companyId:id,companyTaxId:"769199861",matches:[{taxId:"other"}]});
  await assert.rejects(customerProfitabilityTool(s,args),/identidad/);
});
test("Productos con RUT ambiguo o usuario sin permiso no revelan ventas",async()=>{
  const ambiguous=await new ToolRegistry(source({companies:[company,{...company,id:otherId}]})).execute("get_customer_products",{company_id:id});
  assert.equal(ambiguous.status,"needs_clarification"); assert.equal(ambiguous.data,null);
  const s=source({role:"vendedor"}); const denied=await new ToolRegistry(s).execute("get_customer_products",{company_id:id});
  assert.equal(denied.status,"forbidden"); assert.equal(s.calls.length,0);
});
test("Perfil entrega campos comerciales y conserva consentimiento sin ejecutar acciones",async()=>{
  const s=source(); const r=await new ToolRegistry(s).execute("get_customer_profile",{company_id:id});
  assert.equal(r.data.company.type,"distribuidor"); assert.equal(r.data.company.whatsapp_opt_in,false);
  assert.equal(r.data.purchaseHistory.invoiceCount,1); assert.equal(r.data.company.status,"prospecto");
  assert.ok(s.calls.some(c=>typeof c==="string"&&c.includes("contact_name,contact_role")));
  assert.equal(s.calls.filter(c=>c.init).length,0);
  assert.ok(specialists.find(s=>s.id==="commercial").tools.includes("get_customer_products"));
});

const sourceCode=await readFile(new URL("../src/modules/companies/CompanyInsights.tsx",import.meta.url),"utf8");
const compiled=ts.transpileModule(sourceCode,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={}, nativeRequire=createRequire(import.meta.url);
new Function("require","exports","React",compiled)(name=>name.startsWith(".")?{}:nativeRequire(name),exports,React);
const render=(props)=>renderToStaticMarkup(React.createElement(exports.CompanyInsightsView,{loading:false,from:"2026-01-01",to:"2026-09-30",...props}));
test("Ficha muestra provisional, no utilidad exacta; estados vacio/error/permiso visibles",()=>{
  const partial={sales:1000,missingCostDocuments:0,pendingCreditNotes:1,analysis:{status:"provisional",sales:1000,cost:700,grossProfit:300,margin:30}};
  const data={profile:{data:{}},profitability:{data:{ranking:[partial]},status:"partial"},products:{data:{},status:"empty",warnings:[]}};
  const html=render({data}); assert.match(html,/Provisional/); assert.match(html,/\$300/); assert.match(html,/reversas de costo pendientes/);
  assert.match(render({loading:true}),/Consultando historial/); assert.match(render({error:"Falla controlada"}),/role="alert"/);
  assert.match(render({data:{...data,profitability:{status:"forbidden"}}}),/Tu perfil no tiene acceso/);
});
test("Tabla movil anula el ancho minimo global del CRM para no ocultar importes",async()=>{
  const css=await readFile(new URL("../src/modules/companies/company-insights.css",import.meta.url),"utf8");
  assert.match(css,/@media \(max-width:640px\)[\s\S]*\.company-products-scroll table,\.company-products-scroll tbody \{ display:block; min-width:0; width:100%; \}/);
});
