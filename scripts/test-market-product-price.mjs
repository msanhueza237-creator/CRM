import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productText,fetchPublicProduct} from '../supabase/functions/market-study/public-source.ts';
import {webOffer,refreshMarketSources,searchSources} from '../supabase/functions/market-study/market-search.ts';
import {toNetClp} from '../src/modules/market-study/marketMath.ts';
const url='https://tienda.cl/balanza',at='2026-10-06T19:40:00Z';
const structured=p=>'<html><body><main><h1>Balanza 100 kg</h1></main><script type="application/ld+json">'+JSON.stringify(p)+'</script></body></html>';
const offer={ '@type':'Offer',price:107633,priceCurrency:'CLP',sku:'SYN-1',availability:'https://schema.org/InStock'};
const product={ '@type':'Product',name:'Balanza 100 kg',sku:'SYN-1',offers:offer};
const facts=(html,source=url)=>JSON.parse(productText(html,source).split('\n')[0]);
test('AggregateOffer con una sola oferta y monto conciliado: extrae precio, no un rango',()=>{
 const aggregate={ '@type':'AggregateOffer',offerCount:1,lowPrice:107633,highPrice:107633,priceCurrency:'CLP',offers:[offer]};
 assert.equal(facts(structured({...product,offers:aggregate})).price,107633);
 for(const change of [{offerCount:2},{highPrice:110000},{lowPrice:100000},{priceCurrency:'USD'},{offers:[]},{offers:[{...offer,sku:'OTHER'}]},{offers:[offer,offer]}]){
  assert.throws(()=>facts(structured({...product,offers:{...aggregate,...change}})),/variantes/);
 }
});
const woo=(price='$115.000')=>`<html><body class="single-product woocommerce"><main><div class="product type-product product-type-simple"><h1 class="product_title">Balanza 100 kg</h1><div class="elementor-widget-woocommerce-product-price"><p class="price"><span class="woocommerce-Price-amount"><span class="woocommerce-Price-currencySymbol">$</span>${price.slice(1)}</span></p></div><div class="woocommerce-product-details__short-description">Capacidad 100 kg</div><span class="sku">SYN-1</span><p class="stock in-stock">25 disponibles</p><section class="related"><div class="product type-product"><p class="price"><span class="woocommerce-Price-amount">$9.000</span></p></div></section></div></main></body></html>`;
test('WooCommerce/Elementor: precio de ficha simple, relacionado fuera y CLP supuesto visible',()=>{
 const f=facts(woo()),o=webOffer(url,'',JSON.stringify(f),'SYN-1','Balanza 100 kg',at);
 assert.equal(f.price,115000);assert.equal(f.currencyAssumed,true);assert.equal(f.description,'Capacidad 100 kg');
 assert.equal(o.amount,115000);assert.equal(o.vat,'gross');assert.equal(o.vat_percent,19);assert.equal(o.package_quantity,1);assert.equal(o.availability,'available');
 assert.equal(Math.round(toNetClp(o.amount,o.currency,o.vat,o.vat_percent,null)),96639);
 const sale=woo().replace('<p class="price">','<p class="price"><del><span class="woocommerce-Price-amount">$150.000</span></del>');
 assert.equal(facts(sale).price,115000);
 for(const html of [woo('$115.000 - $120.000'),woo().replace('product-type-simple','product-type-variable'),woo().replace('$</span>','US$</span>'),woo().replace('<p class="price">','<p class="price">Desde '),woo().replace('<main>','<meta property="product:price:currency" content="USD"><main>')]){
  assert.throws(()=>facts(html));
 }
 assert.throws(()=>facts(woo(),'https://tienda.com/producto'));
});
const sodaUrl='https://www.sodimac.cl/sodimac-cl/articulo/123/Balanza/456';
const sodaOffers=[{...offer,sku:'456',price:'33290'},{...offer,sku:'456',price:'58990'}];
const sodaProduct={...product,sku:'456',offers:sodaOffers};
const prices=[{crossed:false,type:'eventPrice',price:['33.290'],label:'',icons:''},{crossed:true,type:'normalPrice',price:['58.990'],label:'',icons:''}];
const soda=(pp={},variant={},p=sodaProduct)=>structured(p).replace('</body>','<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{productData:{primaryVariantId:'456',isPublished:true,variants:[{id:'456',prices,...variant}],...pp},unrelated:{prices:[1]}}}})+'</script></body>');
test('Marketplace: promocion vigente no tachada, SKU exacto y metadata conciliada; no minimo arbitrario',()=>{
 const f=facts(soda(),sodaUrl);assert.equal(f.price,'33290');assert.match(f.priceEvidence,/eventPrice/);
 const card={crossed:false,type:'cmrPrice',price:['29.990']};
 assert.equal(facts(soda({}, {prices:[...prices,card]}),sodaUrl).price,'33290');
 const invalid=[soda({primaryVariantId:'OTHER'}),soda({isPublished:false}),soda({}, {prices:[card]}),soda({}, {prices:[{...prices[0],label:'Solo tarjeta'}]}),soda({}, {prices:[{...prices[0],price:['1.000']}]}),soda({}, {prices:[prices[0],{...prices[1],crossed:false}]}),soda({}, {},{...sodaProduct,offers:[sodaOffers[1]]})];
 for(const html of invalid)assert.throws(()=>facts(html,sodaUrl),/variantes/);
 assert.throws(()=>facts(soda(),sodaUrl.replace('/456','/457')),/variantes/);
 assert.throws(()=>facts(soda(),'https://tienda.cl/producto'),/variantes/);
});
test('Refresh recupera precios de un estudio anterior sin consulta IA ni mutar el historial',async()=>{
 const job={id:'synthetic',sku:'SYN-1',state:'completed',result:{kind:'market_search',product_title:'Balanza 100 kg',offers:[{url,title:'Balanza',amount:null}]}};
 const before=JSON.stringify(job),calls=[];
 const result=await refreshMarketSources(job,async u=>{calls.push(String(u));return String(u).endsWith('/robots.txt')?new Response('',{status:404}):new Response(woo(),{headers:{'content-type':'text/html'}});});
 assert.equal(result.result.offers[0].amount,115000);assert.equal(result.result.offers[0].price_error,undefined);assert.equal(JSON.stringify(job),before);assert.equal(calls.length,2);
 const gone=await refreshMarketSources(job,async u=>new Response('',{status:404}));
 assert.equal(gone.result.offers[0].amount,null);assert.match(gone.result.offers[0].price_error,/404/);
});
test('404 y restricciones se distinguen; documentos y clips no ocupan cupos de producto',async()=>{
 for(const [status,reason] of [[404,/Enlace.*404/],[403,/restringe.*403/]])await assert.rejects(fetchPublicProduct(url,async u=>String(u).endsWith('/robots.txt')?new Response('',{status:404}):new Response('',{status}),true),reason);
 const result=searchSources({content:[{type:'server_tool_use',name:'web_search',input:{query:'balanza Chile'}},{type:'web_search_tool_result',content:['https://web.cl/docs/file.pdf','https://video.cl/shorts/clips/abc','https://web.cl/product-category/balanza',url].map(url=>({type:'web_search_result',url}))}]});
 assert.deepEqual(result.sources.map(s=>s.url),[url]);
});
