import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizedMarketProfile,marketSearchRestriction} from '../supabase/functions/_shared/market-product-search.ts';
import {productText} from '../supabase/functions/market-study/public-source.ts';
import {webOffer} from '../supabase/functions/market-study/market-search.ts';
test('Perfil literal distingue datos faltantes, conflictos y presentación; no inventa uso',()=>{
 const profile=normalizedMarketProfile({sku:'LX-36575',name:'Balanza 100 kg',description:'Capacidad 150 kg; alimentos y equipaje'});
 assert.equal(profile.use,null);assert.equal(profile.brand,null);assert.ok(profile.conflicts.length>=2);assert.ok(profile.missing.includes('Uso técnico sin confirmar'));
 assert.ok(normalizedMarketProfile({sku:'AV04',name:'Válvula x100'}).conflicts.some(s=>s.includes('Presentación')));
 assert.equal(marketSearchRestriction('HT816'),null);
 assert.equal(normalizedMarketProfile({sku:'X',name:'Termostato',description:'Costo CLP 2000; uso: control de temperatura'}).use,'control de temperatura');
});
test('Foto de ficha usa evidencia pública y rechaza credenciales, tokens y protocolos activos',()=>{
 const source='https://tienda.cl/producto';
 const make=image=>productText('<h1>Termostato</h1><script type="application/ld+json">'+JSON.stringify({'@type':'Product',name:'Termostato',image,offers:{'@type':'Offer',price:10000,priceCurrency:'CLP'}})+'</script>',source);
 const text=make({url:'https://cdn.tienda.cl/producto.jpg'});
 assert.equal(webOffer(source,'Termostato',text,'HT816','Termostato','2026-10-12T00:00:00Z').image_url,'https://cdn.tienda.cl/producto.jpg');
 for(const image of ['javascript:alert(1)','https://user:pass@tienda.cl/a.jpg','https://tienda.cl/a.jpg?token=secret','https://tienda.cl/a.jpg?X-Amz-Signature=secret','https://tienda.cl/a.jpg?email=private'])assert.equal(JSON.parse(make(image).split('\n')[0]).image_url,undefined);
});
