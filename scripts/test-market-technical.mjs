import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productText,withTechnicalFingerprint,fetchPublicProduct} from '../supabase/functions/market-study/public-source.ts';
import {webOffer} from '../supabase/functions/market-study/market-search.ts';
const url='https://herramientas.cl/producto/termometro-t100';
const base={'@type':'Product',name:'Termómetro T100',brand:'Fabricante',model:'T100',sku:'T100',description:'Medición de temperatura -20 a 100 C. Precisión 0.5 C. Precio por unidad.',additionalProperty:[{'@type':'PropertyValue',name:'Voltaje',value:'220 V'}],offers:{'@type':'Offer',price:11900,priceCurrency:'CLP',availability:'https://schema.org/InStock',valueAddedTaxIncluded:true}};
const html=(patch={},tablePrice=11900)=>'<main><h1>Termómetro T100</h1><p>IVA 19% incluido</p><table><tr><th>Precio</th><td>'+tablePrice+'</td></tr><tr><th>Protección</th><td>IP54</td></tr></table></main><script type="application/ld+json">'+JSON.stringify({...base,...patch})+'</script>';
const offer=async(markup)=>webOffer(url,'Termómetro T100',await withTechnicalFingerprint(productText(markup,url)),'OWN','Termómetro',new Date().toISOString());
test('Fingerprint técnico conserva identidad ante precio/stock/IVA/moneda/foto; detecta especificaciones y unidad',async()=>{
 const first=await offer(html());assert.ok(first.technical);assert.equal(first.technical.unit,'unit');assert.equal(first.technical.package_quantity,1);assert.equal(first.package_assumed,false);
 const explicitNet=await offer(html({offers:{...base.offers,valueAddedTaxIncluded:false}}).replace('<p>IVA 19% incluido</p>',''));assert.equal(explicitNet.vat,'net');assert.equal(explicitNet.vat_assumed,false);
 const commercial=await offer(html({image:'https://cdn.herramientas.cl/nueva.jpg',offers:{...base.offers,price:23800,priceCurrency:'USD',availability:'https://schema.org/OutOfStock',valueAddedTaxIncluded:false}},23800));
 assert.equal(commercial.technical.fingerprint,first.technical.fingerprint);
 for(const patch of [{model:'T200'},{sku:'REUSED'},{description:base.description.replace('0.5','2.5')},{additionalProperty:[{name:'Voltaje',value:'110 V'}]},{description:base.description.replace('Precio por unidad.','Pack de 2 unidades.')}])assert.notEqual((await offer(html(patch))).technical?.fingerprint,first.technical.fingerprint);
 assert.notEqual((await offer(html().replace('IP54','IP20'))).technical.fingerprint,first.technical.fingerprint);
 for(const [label,unit] of [['kilogramo','kg'],['metro','m'],['litro','l']]){const read=await offer(html({description:base.description.replace('por unidad','por '+label)}));assert.equal(read.technical.unit,unit);assert.notEqual(read.technical.fingerprint,first.technical.fingerprint);}
});
test('Evidencia técnica incompleta no se transforma en identidad confirmada',async()=>{
 for(const patch of [{model:null,sku:null},{description:'Precio por unidad.'+'x'.repeat(3001)},{description:'Medición de temperatura -20 a 100 C, sin presentación explícita.'},{description:base.description+' Pack de 2 unidades.'}])assert.equal((await offer(html(patch))).technical,undefined);
 const fake=html({technical:{fingerprint:'technical-v1:'+'a'.repeat(64),unit:'unit',package_quantity:1},description:'Unidad desconocida'});assert.equal((await offer(fake)).technical,undefined);
});
test('Reader genera fingerprint sin IA en cada lectura y no usa metadatos de huella del vendedor',async()=>{
 let count=0;const mock=async u=>{count++;return String(u).endsWith('/robots.txt')?new Response('',{status:404}):new Response(html(),{headers:{'content-type':'text/html'}});};
 const result=await fetchPublicProduct(url,mock,true);const parsed=JSON.parse(result.text.split('\n')[0]);assert.match(parsed.technical.fingerprint,/^technical-v1:[a-f0-9]{64}$/);assert.equal(parsed.technical_basis,undefined);assert.equal(count,2);
});

test('Aprobación conserva contexto técnico interno explícito sin datos privados ni permisos nuevos',async()=>{
 const {normalizeMarketReview}=await import('../supabase/functions/_shared/market-study-contract.ts');
 const r={observation_id:'11111111-1111-4111-8111-111111111111',request_id:'22222222-2222-4222-8222-222222222222',expected_review_id:null,decision:'approved',product_key:'current:T100',sku:'T100',unit:'unit',internal_quantity:1,equivalence_confirmed:true,cost_basis_confirmed:false,internal_fx:null,reason:'Verificación humana del modelo y presentación.',internal_product:{name:'Termómetro T100',description:'Voltaje 220 V; Costo CLP 2000; Contacto privado@example.com',brand:'Fabricante'}};
 const parsed=normalizeMarketReview(r);assert.deepEqual(parsed.internal_product,{name:'Termómetro T100',description:'Voltaje 220 V',brand:'Fabricante'});
 assert.throws(()=>normalizeMarketReview({...r,internal_product:{name:'',description:'a'}}));
 assert.throws(()=>normalizeMarketReview({...r,equivalence_confirmed:false}));
 assert.equal(normalizeMarketReview({...r,internal_product:undefined}).internal_product,undefined);
});
