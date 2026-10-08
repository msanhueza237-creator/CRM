import assert from "node:assert/strict";
import {previewWhatsAppAutomation} from "../supabase/functions/crm-agent/whatsapp-automation-preview.ts";
const companyId='00000000-0000-4000-8000-000000000001',phone='56912345678';
const envelope=message=>({object:'whatsapp_business_account',entry:[{id:'b1',changes:[{field:'messages',value:{metadata:{phone_number_id:'p1'},messages:[message]}}]}]});
const inbound=(extra={})=>({id:'in1',company_id:companyId,direction:'inbound',phone_number:'+'+phone,meta_message_id:'wamid.in1',message_type:'text',status:'received',occurred_at:new Date().toISOString(),body:'Hola',raw_payload:envelope({id:'wamid.in1',from:phone,type:'text',text:{body:'Hola'},timestamp:String(Math.floor(Date.now()/1000)-60)}),...extra});
const defaults={META_GRAPH_API_VERSION:'v26.0',META_WHATSAPP_ACCESS_TOKEN:'synthetic-only',META_WHATSAPP_PHONE_NUMBER_ID:'p1',META_WHATSAPP_BUSINESS_ACCOUNT_ID:'b1',META_WHATSAPP_PRODUCTION_APPROVED:'true',META_WHATSAPP_APP_SECRET:'synthetic-only',META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'synthetic-only',WHATSAPP_STORE_CURRENCY:'CLP',WHATSAPP_LIVE_CATALOG_ENABLED:'true',TIENDANUBE_STORE_ID:'123',TIENDANUBE_ACCESS_TOKEN:'synthetic-only',TIENDANUBE_USER_AGENT:'SyntheticTest/1.0'};
const env=keys=>keys.map(k=>defaults[k]).find(Boolean)||'';
function dbFixture(extra={}) {
 const tables={companies:[{id:companyId,name:'Cliente prueba',whatsapp_status:'sin_consentimiento'}],contacts:[],whatsapp_settings:[{active:true,phone_number_id:'p1',business_account_id:'b1'}],whatsapp_messages:[inbound()],content_products:[],...extra};
 return {tables,from(name){let filters=[],order=[],start=0,end=Infinity,op='select',value;const q={
  select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},
  contains(k,json){const values=JSON.parse(json);filters.push(r=>values.every(v=>r[k].some(item=>Object.entries(v).every(([key,value])=>item[key]===value))));return q},
  order(k,o={ascending:true}){order.push([k,o.ascending]);return q},limit(n){end=n;return q},range(a,b){start=a;end=b+1;return q},
  insert(){throw Error('Unexpected database write')},update(){throw Error('Unexpected database write')},single(){return q.maybeSingle()},maybeSingle(){return q.then(r=>({...r,data:r.data?.[0]||null}))},
  then(resolve,reject){return Promise.resolve().then(()=>{
   if(op==='insert'){if(tables[name].some(r=>r.id===value.id))return {error:{code:'23505'},data:null};tables[name].push({occurred_at:new Date().toISOString(),...value});return {error:null,data:null}}
   let rows=tables[name].filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,value));
   rows.sort((a,b)=>{for(const [k,asc] of order){const n=String(a[k]).localeCompare(String(b[k]));if(n)return asc?n:-n}return 0});
   return {data:rows.slice(start,end).map(r=>({...r})),error:null};
  }).then(resolve,reject)}
 };return q}};
}

export function scenario(text='precio y stock LX1030') {
 const incoming=inbound();incoming.raw_payload.entry[0].changes[0].value.messages[0].text.body=text;
 const old=new Date(Date.now()-3600000).toISOString();
 const product={name:'Manómetro R32',external_id:'456',source_provider:'tiendanube',source_status:'active',paused:false,sync_status:'synced',product_url:'https://tienda.example/productos/manometro/',last_synced_at:old,source_updated_at:old,variants:[{id:789,sku:'LX1030',price:'34500',stock:5,stock_management:true}]};
 const db=dbFixture({whatsapp_messages:[incoming],content_products:[product]});
 const calls=[];
 const payload={id:456,name:{es:product.name},published:true,variants:[{id:789,sku:'LX1030',price:'40000',promotional_price:'32000',stock:2,stock_management:true}]};
 const fetcher=async(url,options)=>{assert.equal(url,'https://api.tiendanube.com/2025-03/123/products/456');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);calls.push(url);return Response.json(payload)};
 return {db,incoming,product,payload,calls,fetcher,env,query:new URLSearchParams({companyId,phone})};
}
export async function run(s,fetcher=s.fetcher,environment=env){return previewWhatsAppAutomation(s.db,environment,s.query,fetcher)}
