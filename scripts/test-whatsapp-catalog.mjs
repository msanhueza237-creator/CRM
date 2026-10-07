import test from 'node:test';
import assert from 'node:assert/strict';
import { storedCatalogSelection, getWhatsAppCatalogSelections } from '../supabase/functions/crm-agent/whatsapp-catalog.ts';

const order=(items=[{product_retailer_id:'1001600453',quantity:1,item_price:34500,currency:'CLP'}])=>({
 id:'message-1',direction:'inbound',meta_message_id:'wamid-1',raw_payload:{entry:[{changes:[{value:{messages:[{id:'wamid-1',type:'order',order:{catalog_id:'catalog-1',text:'Necesito cotizacion',product_items:items}}]}}]}]}
});
const product=(extra={})=>({id:'p1',source_provider:'tiendanube',name:'Manometro con manguera de carga',variants:[{id:1001600453,sku:'LX1030',price:'99999',cost:'private',stock:99,values:[{es:'R32'}],image_id:7}],images:[{id:7,src:'https://cdn.example.test/variant.png'}],primary_image_url:'https://cdn.example.test/product.png',product_url:'https://climactiva.cl/productos/manometro',source_updated_at:'2026-08-21T00:00:00Z',...extra});
function database(rows=[],fail=false){
 const calls=[];
 return {calls,from(table){assert.equal(table,'content_products');let filters=[],limit=Infinity;const q={
  select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},
  contains(k,values){calls.push(values);filters.push(r=>values.every(v=>r[k].some(item=>Object.entries(v).every(([key,value])=>item[key]===value))));return q},
  order(){return q},limit(n){limit=n;return q},
  then(resolve,reject){return Promise.resolve(fail?{error:{message:'secret-database-error'}}:{data:rows.filter(r=>filters.every(f=>f(r))).slice(0,limit)}).then(resolve,reject)}
 };return q}};
}

test('exact Tiendanube variant ID resolves name, SKU and image without replacing received prices',async()=>{
 const source=order(),before=structuredClone(source),db=database([product()]);
 const selections=await getWhatsAppCatalogSelections(db,[source]);
 const item=selections.get('message-1').items[0];
 assert.equal(item.product.name,'Manometro con manguera de carga');assert.equal(item.product.sku,'LX1030');
 assert.equal(item.product.variant,'R32');assert.equal(item.product.imageUrl,'https://cdn.example.test/variant.png');
 assert.equal(item.product.matchedBy,'variant_id');assert.equal(item.unitPrice,34500);assert.equal(item.total,34500);
 assert.equal(JSON.stringify(item).includes('private'),false);assert.equal(JSON.stringify(item).includes('stock'),false);
 assert.deepEqual(source,before);
});
test('supports string variant IDs and exact SKU without fuzzy name/price matching',async()=>{
 const p=product({variants:[{id:'1001600453',sku:'LX1030'}]});
 const selection=await getWhatsAppCatalogSelections(database([p]),[order([{product_retailer_id:'LX1030',quantity:2,item_price:'34000',currency:'CLP'}])]);
 assert.equal(selection.get('message-1').items[0].product.matchedBy,'sku');
 const missing=await getWhatsAppCatalogSelections(database([p]),[order([{product_retailer_id:'LX103',quantity:1,item_price:34500,currency:'CLP'}])]);
 assert.equal(missing.get('message-1').items[0].resolution,'not_found');
});
test('ambiguous variant/SKU identities never silently choose the first product',async()=>{
 const other=product({id:'p2',name:'Different item'});
 const selections=await getWhatsAppCatalogSelections(database([product(),other]),[order()]);
 assert.equal(selections.get('message-1').items[0].resolution,'ambiguous');
 assert.equal(selections.get('message-1').items[0].product,null);
 const collision=product({id:'p3',variants:[{id:9,sku:'1001600453'}]});
 const conflict=await getWhatsAppCatalogSelections(database([product(),collision]),[order()]);
 assert.equal(conflict.get('message-1').items[0].resolution,'ambiguous');
 const incomplete=await getWhatsAppCatalogSelections(database([product(),product({id:'p4',name:''})]),[order()]);
 assert.equal(incomplete.get('message-1').items[0].resolution,'ambiguous');
});
test('catalog lookup failure keeps the received order and hides internal errors',async()=>{
 const result=await getWhatsAppCatalogSelections(database([],true),[order()]);
 const selection=result.get('message-1');
 assert.equal(selection.items[0].resolution,'unavailable');assert.equal(selection.items[0].unitPrice,34500);
 assert.equal(selection.text,'Necesito cotizacion');assert.equal(JSON.stringify(selection).includes('secret'),false);
});
test('multiple quantities/currencies stay independent; missing numbers are not zero',()=>{
 const parsed=storedCatalogSelection(order([
  {product_retailer_id:'a',quantity:2,item_price:34.5,currency:'USD'},
  {product_retailer_id:'b',quantity:3,item_price:0,currency:'CLP'},
  {product_retailer_id:'c',quantity:'',item_price:null,currency:'CLP'},
  {product_retailer_id:'d',quantity:-1,item_price:'invalid',currency:'invalid'},
 ]));
 assert.equal(parsed.items[0].total,69);assert.equal(parsed.items[0].currency,'USD');assert.equal(parsed.items[1].total,0);
 assert.equal(parsed.items[2].total,null);assert.equal(parsed.items[2].quantity,null);assert.equal(parsed.items[2].unitPrice,null);
 assert.equal(parsed.items[3].total,null);assert.equal(parsed.items[3].currency,null);
});
test('product enquiries resolve the reference without inventing order quantities or prices',async()=>{
 const source=order();source.raw_payload.entry[0].changes[0].value.messages[0]={id:'wamid-1',type:'text',text:{body:'Hay disponibilidad?'},context:{referred_product:{catalog_id:'catalog-1',product_retailer_id:'1001600453'}}};
 const result=await getWhatsAppCatalogSelections(database([product()]),[source]);
 const selection=result.get('message-1');assert.equal(selection.kind,'enquiry');assert.equal(selection.items[0].product.sku,'LX1030');
 assert.equal(selection.items[0].quantity,null);assert.equal(selection.items[0].unitPrice,null);
});
test('matches original message identity only; ordinary/outbound messages do not query catalog',async()=>{
 const source=order(),db=database([product()]);
 assert.equal(storedCatalogSelection({...source,meta_message_id:'other'}),null);
 assert.equal(storedCatalogSelection({...source,direction:'outbound'}),null);
 const result=await getWhatsAppCatalogSelections(db,[{id:'text',direction:'inbound',body:'Hola'}]);
 assert.equal(result.size,0);assert.equal(db.calls.length,0);
});
test('URLs reject active schemes and credentials; duplicate references reuse one lookup',async()=>{
 const p=product({images:[],primary_image_url:'javascript:alert(1)',product_url:'https://token@climactiva.cl/productos/a'});
 const source=order();source.raw_payload.entry[0].changes[0].value.messages[0].order.product_items.push({product_retailer_id:'1001600453',quantity:2,item_price:34500,currency:'CLP'});
 const db=database([p]);const result=await getWhatsAppCatalogSelections(db,[source]);
 assert.equal(db.calls.length,3);assert.equal(result.get('message-1').items.length,2);
 assert.equal(result.get('message-1').items[0].product.url,null);assert.equal(result.get('message-1').items[0].product.imageUrl,null);
});
