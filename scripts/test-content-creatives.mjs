import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import ts from 'typescript';

const base = process.env.CONTENT_STUDIO_URL || 'http://127.0.0.1:5190';
const output = 'outputs/content-designs';
await mkdir(output, { recursive: true });
const realProducts = await readFile('tmp/content-studio/products.json', 'utf8').then(JSON.parse).catch(() => null);
const example = { id: '11111111-1111-4111-8111-111111111111', sku: 'QA-TOOL', name: 'Abocardador de prueba', description_text: 'Abocardador con trinquete\nEspecificaciones Técnicas\nParámetro\nDetalle Técnico\nModelo\nQA-TOOL\nÁngulo\n45 grados\nMedidas\n1/4 y 3/8', brand: 'Marca de prueba', category: 'Herramientas', primary_image_url: 'https://example.test/tool.jpg', images: [], source_status: 'active', sync_status: 'synced', paused: false, stock: 3, price: 1000, promotional_price: null };
const products = realProducts || [example, { ...example, id: '22222222-2222-4222-8222-222222222222', sku: 'QA-SECOND', name: 'Segundo producto' }];
const first = products.find((p) => p.sku === 'ST-R806A') || products[0];
const api = `
export async function fetchContentCreativePreview(id,signal){window.sourceReads++;if(window.failImage)throw new Error('Imagen temporalmente no disponible');return (await fetch('/qa-image/'+id,{signal})).blob()}
export async function fetchContentCreativeSource(id,url){return (await fetch('/qa-image/'+window.publications[id].product_id)).blob()}
export async function generateSocialContent(input){window.generateInputs.push(input);const product=window.products.find(p=>p.id===input.productId);const publications=input.channels.map((channel,i)=>({id:'draft-'+i,product_id:product.id,channel_id:channel,status:'pending_approval',image_url:product.primary_image_url,body:'Texto de prueba conservado.',hashtags:['Climactiva'],cta:'climactiva.cl',source_facts:{media_urls:[product.primary_image_url],creative_layout:input.visualLayout}}));publications.forEach(p=>window.publications[p.id]=p);return{publications}}
export async function uploadContentCreative(id,blob,index){window.uploads++;const publicUrl='https://qa-creatives.test/'+window.uploads+'.jpg';window.creativeBytes[publicUrl]=Array.from(new Uint8Array(await blob.arrayBuffer()));return {path:'qa/'+window.uploads+'.jpg',publicUrl}}
export async function attachContentCreatives(id,urls,layout){window.attachments.push({id,urls,layout});const publication={...window.publications[id],source_facts:{...window.publications[id].source_facts,designed_media_urls:urls,creative_layout:layout}};window.publications[id]=publication;return{publication}}
export async function removeContentCreatives(){}
export async function approveContentPublication(){throw new Error('No se aprueba en esta prueba')}
export async function rejectContentPublication(){throw new Error('No se rechaza en esta prueba')}
export async function scheduleContentPublication(){throw new Error('No se programa en esta prueba')}
export async function publishContentPublication(){throw new Error('No se publica en esta prueba')}
`;
const fixture = `import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {default:React}=await import('/node_modules/.vite/deps/react.js');const {useState}=React;
const {default:ReactDOM}=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=ReactDOM;
const {ContentGenerator}=await import('/src/modules/content/ContentGenerator.tsx');
window.products=${JSON.stringify(products)};
window.sourceReads=0;window.uploads=0;window.generateInputs=[];window.attachments=[];window.creativeBytes={};window.publications={};
const data={products:window.products,bootstrap:{channels:[{id:'instagram',code:'instagram',name:'Instagram'},{id:'facebook',code:'facebook',name:'Facebook'}],templates:[{id:'template',name:'Técnico',active:true}],brands:[{id:'brand',name:'CLIMACTIVA'}]},refresh:async()=>{}};
function App(){const[id,setId]=useState(${JSON.stringify(first.id)});return React.createElement(ContentGenerator,{data,selectedProductId:id,onProductChange:setId})}
createRoot(document.getElementById('root')).render(React.createElement(App));`;

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.route('**/creative-design-qa', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estudio visual CLIMACTIVA</title><link rel="stylesheet" href="/src/styles.css"><body><main id="root" style="max-width:1240px;margin:auto;padding:24px"></main><script type="module" src="/qa-fixture.js"></script></body></html>' }));
  await context.route('**/qa-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  await context.route('**/src/lib/contentCenterApi.ts', route => route.fulfill({ contentType: 'text/javascript', body: api }));
  await context.route('**/src/modules/auth/AuthContext.tsx', route => route.fulfill({ contentType: 'text/javascript', body: "export const useAuth=()=>({user:{role:'administrador'}});" }));
  await context.route('**/qa-image/*', async route => {
    const index = products.findIndex((p) => p.id === route.request().url().split('/').pop());
    if (realProducts) return route.fulfill({ body: await readFile(`tmp/content-studio/product-${index}.${index === 0 ? 'png' : 'jpg'}`), contentType: index === 0 ? 'image/png' : 'image/jpeg' });
    return route.fulfill({ body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVZkAAAAASUVORK5CYII=', 'base64'), contentType: 'image/png' });
  });
  const page = await context.newPage(); const errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await context.route('https://qa-creatives.test/**', async route => route.fulfill({ contentType: 'image/jpeg', body: Buffer.from(await page.evaluate(url => window.creativeBytes[url], route.request().url())) }));
  await page.addInitScript(() => { window.drawnText = []; const draw = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(...args) { window.drawnText.push(args[0]); return draw.apply(this, args); }; });
  await page.goto(base + '/creative-design-qa');
  const preview = page.locator('.content-preview-surface > img');
  console.log('Studio loaded. Checking compositions and download.');
  async function ready() { await preview.waitFor(); await preview.evaluate(img => img.decode()); }
  await ready();
  assert.equal(await page.getByRole('button', { name: /^Diseño / }).count(), 6);
  assert.equal(await page.evaluate(() => window.sourceReads), 1);
  const frames = [];
  for (const [id, label] of [['technical','Ficha técnica'],['editorial','Protagonista'],['industrial','Industrial'],['laboratory','Laboratorio'],['promotion','Oferta']]) {
    await page.getByRole('button', { name: 'Diseño ' + label, exact: true }).click();
    await ready();
    assert.equal(await preview.evaluate(img => img.naturalWidth), 1080);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Descargar diseño', exact: true }).click()]);
    await download.saveAs(output + '/' + id + '.jpg');
    frames.push(await preview.evaluate(img => { const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const c=canvas.getContext('2d');c.drawImage(img,0,0,32,32);return [...c.getImageData(0,0,32,32).data]; }));
  }
  for (let a=0;a<frames.length;a++) for(let b=a+1;b<frames.length;b++) {
    const difference=frames[a].reduce((sum,value,i)=>sum+Math.abs(value-frames[b][i]),0)/frames[a].length;
    assert.ok(difference>12, 'Layouts must differ visibly, not merely change a small accent: '+difference);
  }
  const facts = await page.evaluate(async()=>{const module=await import('/src/modules/content/contentCreative.ts');return module.getCreativeFacts(window.products.find(p=>p.sku==='ST-R806A')||window.products[0]);});
  assert.ok(facts.some(f=>/45/.test(f.value)));
  const defaultCopy=await page.evaluate(async()=>{const module=await import('/src/modules/content/contentCreative.ts');return module.defaultCreativeLayout(window.products.find(p=>p.sku==='ST-R806A')||window.products[0]);});
  assert.doesNotMatch(defaultCopy.supporting_text,/^(Modelo|SKU|Marca)\s*[:/]/i);
  assert.doesNotMatch((await page.evaluate(()=>window.drawnText)).join(' '), /CLIMA ACTIVA|&[a-z]+;|…/);
  await page.getByLabel('Titular visual', { exact:true }).fill('Abocardador con trinquete para trabajo técnico');
  await page.getByRole('button', { name:'Alternar diseño',exact:true }).click();
  await ready();
  assert.equal(await page.getByLabel('Titular visual',{exact:true}).inputValue(),'Abocardador con trinquete para trabajo técnico');
  await page.getByRole('button',{name:'Restablecer textos del producto',exact:true}).click(); await ready();
  for(const width of [1440,768,390,360]) {
    await page.setViewportSize({width,height:980});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow at '+width);
    await page.screenshot({path:output+'/studio-'+width+'.png',fullPage:true});
  }
  await page.getByRole('button',{name:'Generar borradores',exact:true}).click();
  await page.getByRole('button',{name:'Aplicar diseño a 2 borrador(es)',exact:true}).waitFor();
  await page.waitForFunction(()=>window.attachments.length===2);
  assert.equal(await page.evaluate(()=>window.uploads),1,'Only the main image is uploaded, shared by both channels');
  assert.ok(await page.evaluate(()=>window.attachments.every(a=>a.urls.length===1)));
  await page.getByRole('button',{name:'Diseño Industrial',exact:true}).click(); await ready();
  await page.getByRole('button',{name:'Aplicar diseño a 2 borrador(es)',exact:true}).click();
  await page.waitForFunction(()=>window.attachments.length===4);
  assert.equal(await page.evaluate(()=>window.generateInputs.length),1,'Changing the graphic must not regenerate AI text');
  assert.ok(await page.evaluate(()=>Object.values(window.publications).every(p=>p.body==='Texto de prueba conservado.'&&p.status==='pending_approval'&&p.source_facts.creative_layout.style==='industrial')));
  const other=products.find(p=>p.id!==first.id);
  await page.evaluate(()=>window.failImage=true);
  await page.getByLabel('Producto',{exact:true}).selectOption(other.id);
  await page.getByText('Imagen temporalmente no disponible',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Descargar diseño',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.failImage=false);
  await page.getByRole('button',{name:'Reintentar',exact:true}).click(); await ready();
  console.log('Draft workflow and image retry passed. Rendering other catalog products.');
  for (const product of products.filter(p=>p.id!==first.id)) {
    await page.getByLabel('Producto',{exact:true}).selectOption(product.id); await ready();
    for(const [style,label] of [['technical','Ficha técnica'],['editorial','Protagonista'],['industrial','Industrial'],['laboratory','Laboratorio'],['promotion','Oferta']]) {
      await page.getByRole('button',{name:'Diseño '+label,exact:true}).click(); await ready();
      const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Descargar diseño',exact:true}).click()]);
      await download.saveAs(output+'/'+product.sku.replace(/[^a-z0-9-]/gi,'-')+'-'+style+'.jpg');
    }
  }
  const crops = await page.evaluate(async()=>{
    const {renderContentCreative,defaultCreativeLayout}=await import('/src/modules/content/contentCreative.ts');
    const calls=[],original=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.width===1080&&args.length===9)calls.push(args.slice(1,5));return original.apply(this,args);};
    try { for(const inset of [64,0]) {
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
      const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,256,256);context.fillStyle='black';context.fillRect(inset,inset,256-inset*2,256-inset*2);
      await renderContentCreative({imageBlob:await new Promise(resolve=>canvas.toBlob(resolve)),product:window.products[0],layout:defaultCreativeLayout(window.products[0])});
    }} finally {CanvasRenderingContext2D.prototype.drawImage=original;}return calls;
  });
  assert.ok(crops[0][0]<64&&crops[0][1]<64&&crops[0][0]+crops[0][2]>192&&crops[0][1]+crops[0][3]>192,'Keep the entire object with safety margin');
  assert.ok(crops[0][2]<256,'Use empty surround for a larger product');
  assert.deepEqual(crops[1],[0,0,256,256],'Keep the full context when the image reaches the border');
  if(realProducts && await readFile(output+'/index.html').catch(()=>null)) {
    await page.goto(base+'/'+output+'/index.html');
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:980});
      await page.locator('#poster').evaluate(img=>img.decode());
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:output+'/gallery-'+width+'.png',fullPage:true});
    }
    for(const prefix of ['','ST-4BMC-','FLARE-3-8-']) {
      await page.locator('#product').selectOption(prefix);
      for(const style of ['technical','editorial','industrial','laboratory','promotion']) {
        await page.locator('[data-style="'+style+'"]').click();
        await page.locator('#poster').evaluate(img=>img.decode());
        assert.equal(await page.locator('#poster').evaluate(img=>img.naturalWidth),1080);
      }
    }
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Descargar JPG'}).click()]);
    assert.equal(download.suggestedFilename(),'CLIMACTIVA-FLARE-3-8-promotion.jpg');
  }
  assert.deepEqual(errors,[]);
  await context.close();
} finally { await browser.close(); }

const edge=await readFile('supabase/functions/content-center/index.ts','utf8');
const tree=ts.createSourceFile('index.ts',edge,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const node=tree.statements.find(n=>n.name?.text==='normalizeCreativeLayout');
const code=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const normalize=new Function('asObject','oneOf','optionalText',code+';return normalizeCreativeLayout;')(v=>v||{},(v,list,fallback)=>list.includes(v)?v:fallback,(v,max)=>String(v||'').slice(0,max));
for(const style of ['technical','editorial','industrial','laboratory','promotion','original']) assert.equal(normalize({style}).style,style);
assert.match(edge,/requirePermission\(profile, "content.generate"\);\s*return await proxyCreativeSource/);
assert.match(edge,/const sourceUrl = productImageUrls\(products\[0\]\)\[0\]/);
assert.match(edge,/allowedUrls.includes\(sourceUrl\)/);
console.log('Cinco composiciones, textos, datos técnicos, descarga, edición de borradores y móvil verificados. Sin escrituras externas.');
