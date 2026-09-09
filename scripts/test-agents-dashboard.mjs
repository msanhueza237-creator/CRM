import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const browser=await chromium.launch({headless:true,channel:'chrome'});
await mkdir('tmp/agents-dashboard-qa',{recursive:true});
try {
  for (const width of [1440,768,390,360]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:5183/scripts/fixtures/agents-center.html');
    await page.getByRole('heading',{name:'Centro de agentes',exact:true}).waitFor();
    assert.equal(await page.locator('.ac-agent').count(),7);
    const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(overflow.scroll<=overflow.width,JSON.stringify(overflow));
    await page.screenshot({path:`tmp/agents-dashboard-qa/${width}.png`,fullPage:true});
    await page.getByLabel('Buscar agente o modulo').fill('cobranza'); assert.equal(await page.locator('.ac-agent').count(),1);
    await page.getByLabel('Buscar agente o modulo').fill('');
    await page.getByRole('button',{name:'Con error',exact:true}).click(); assert.equal(await page.locator('.ac-agent').count(),1);
    await page.getByRole('button',{name:'Todos',exact:true}).click();
    await page.getByLabel('Analizar Comercial',{exact:true}).click(); assert.equal(await page.getByLabel('Resultado de prueba').textContent(),'request:commercial');
    await page.getByRole('tab',{name:'Conexiones',exact:true}).click(); await page.getByText('Sincronizacion pendiente',{exact:true}).waitFor();
    await page.getByRole('tab',{name:'Pendientes (1)',exact:true}).click();
    await page.locator('.ac-proposal summary').click(); await page.getByRole('button',{name:'Aprobar',exact:true}).click(); assert.equal(await page.getByLabel('Resultado de prueba').textContent(),'p1:approved');
    await page.getByRole('button',{name:/Ver actividad del/}).last().click(); assert.equal(await page.locator('.ac-activity-row').count(),7);
    await page.getByRole('link',{name:'Comercial',exact:true}).click(); assert.equal(await page.getByLabel('Ruta de prueba').textContent(),'/agentes/commercial/dashboard');
    assert.deepEqual(errors,[]); await page.close();
  }
  const page=await browser.newPage(); await page.goto('http://127.0.0.1:5183/scripts/fixtures/agents-center.html?readonly');
  await page.getByLabel('Analizar Comercial',{exact:true}).waitFor(); assert.equal(await page.getByLabel('Analizar Comercial',{exact:true}).isDisabled(),true);
  console.log('Dashboard: 1440/768/390/360px, sin overflow, filtros, tabs, grafico, acciones, enlaces y solo lectura verificados.');
} finally { await browser.close(); }
