// Isolated browser harness: mocks only the persistence boundary, denies external requests.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { scenarioSnapshot, scenarioComparison, scenarioNumber } from '../src/modules/foreign-trade/foreignTradeSavedScenarios.ts';
assert.equal(scenarioNumber(null), 'No registrado');
assert.equal(scenarioNumber(0, '%'), '0 %');
assert.equal(scenarioSnapshot({ operation_id: 'other', assumptions: { snapshot: { version: 1, operation_id: 'op', lines: [], costs: [] } } }, 'op'), null);
assert.equal(scenarioSnapshot({ operation_id: 'op', assumptions: { snapshot: { version: 1, operation_id: 'op', lines: [{ operation_id: 'other' }], costs: [] } } }, 'op'), null);
assert.equal(scenarioComparison({ assumptions: {}, allocation_method: 'manual' }).find(([key]) => key === 'Método de precio')[1], 'No registrado');
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ForeignTradeCostingPanel} from '/src/modules/foreign-trade/ForeignTradeCostingPanel.tsx';
import '/src/styles.css'; import '/src/modules/foreign-trade/foreignTradeMobile.css';
window.calls=[];
const assumptions={costing:{pricing_method:'markup_on_cost',target_percent:45,general_duty_percent:6,import_vat_percent:19,sales_vat_percent:19,import_vat_recoverable:true}};
const base={id:'base',operation_id:'op',name:'Base antigua',status:'baseline',exchange_rate_clp:1000,allocation_method:'fob_value',created_at:'2026-10-20T12:00:00Z',calculated_at:null,assumptions,missing_inputs:[],landed_total_clp:null};
const detail={operation:{id:'op',exchange_rate_clp:1000,exchange_rate_source:'manual'},scenarios:[base,{...base,id:'wrong',operation_id:'wrong',name:'Otra operación'}],lines:[{id:'line',operation_id:'op',product_name:'PIPE 5',quantity:10,currency:'USD',unit_factory_cost:5,fob_total:50}],costs:[],totals:{registered_merchandise:50}};
const parameters=['cl_general_ad_valorem','cl_import_vat','cl_sales_vat'].map((code)=>({code,active:true,numeric_value:code==='cl_general_ad_valorem'?6:19}));
const root=createRoot(document.getElementById('root'));
window.renderOperation=(id='op')=>root.render(<ForeignTradeCostingPanel key={id} detail={{...detail,operation:{...detail.operation,id}}} costParameters={parameters} onSaved={async()=>{if(window.refreshFail)throw Error('refresh')}}/>);
window.changeFixture=()=>{detail.lines=detail.lines.map(line=>({...line,fob_total:100,unit_factory_cost:10}));window.renderOperation()};
window.renderOperation();`;
const server = await createServer({configFile:false,server:{host:'127.0.0.1',port:4179}, plugins:[{
 name:'isolated-scenario-fixture', enforce:'pre',
 resolveId(id) { if(id.endsWith('lib/foreignTradeApi')) return '\0mock-api'; if(id==='/scenario-fixture.jsx')return id; },
 load(id) { if(id==='\0mock-api') return `export async function saveForeignTradeCostingScenario(input){window.calls.push(input);await new Promise(r=>setTimeout(r,150));if(window.fail)throw Error('Fallo simulado');return 'saved-'+window.calls.length}`; if(id==='/scenario-fixture.jsx')return fixture; },
 configureServer(s) {s.middlewares.use('/scenario-test',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/scenario-fixture.jsx"></script></html>')});}
}]});
await server.listen();
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto('http://127.0.0.1:4179/scenario-test');
 await page.getByRole('heading',{name:'Escenarios guardados'}).waitFor();
 assert.equal(await page.getByText('Otra operación',{exact:true}).count(),0);
 const name=page.getByRole('textbox',{name:'Nombre de la copia'});
 const save=page.getByRole('button',{name:'Guardar copia del escenario'});
 await name.fill('Cancelar');await page.getByRole('button',{name:'Cancelar guardado'}).click();assert.equal(await name.inputValue(),'');assert.equal(await page.evaluate(()=>window.calls.length),0);
 await name.fill('Copia A');await save.evaluate(button=>{button.click();button.click()});
 await page.getByRole('button',{name:'Abrir simulación: Copia A',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.length),1);
 const payload=await page.evaluate(()=>window.calls[0]);assert.equal(payload.id,undefined);assert.equal(payload.status,'draft');assert.equal(payload.operationId,'op');assert.equal(payload.snapshot.lines[0].product_name,'PIPE 5');
 await page.evaluate(()=>window.changeFixture());
 await page.getByRole('button',{name:'Abrir simulación: Copia A',exact:true}).click();
 assert.match(await page.getByRole('status').innerText(),/Productos y gastos de la copia/);
 await page.locator('label').filter({hasText:'Objetivo general'}).locator('input').fill('60');
 await page.evaluate(()=>window.refreshFail=true);await name.fill('Copia B');await save.click();await page.getByRole('button',{name:'Abrir simulación: Copia B',exact:true}).waitFor();
 await page.getByText('La copia se guardó, pero no se pudo actualizar la ficha.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls[1].snapshot.lines[0].fob_total),50);
 await page.getByRole('button',{name:'Abrir simulación: Copia A',exact:true}).click();
 assert.equal(await page.locator('label').filter({hasText:'Objetivo general'}).locator('input').inputValue(),'45');
 await page.getByRole('checkbox',{name:'Comparar Copia A',exact:true}).check();await page.getByRole('checkbox',{name:'Comparar Copia B',exact:true}).check();
 assert.equal(await page.getByRole('checkbox',{name:'Comparar Base antigua',exact:true}).isDisabled(),true);
 await page.getByRole('region',{name:'Escenarios guardados'}).screenshot({path:'/tmp/saved-scenarios-mobile.png'});
 const overflow=await page.getByRole('region',{name:'Escenarios guardados'}).evaluate(el=>el.scrollWidth>el.clientWidth);assert.equal(overflow,false);
 await page.getByRole('button',{name:'Abrir simulación: Base antigua',exact:true}).click();assert.match(await page.getByRole('status').innerText(),/Escenario antiguo/);
 await page.evaluate(()=>window.fail=true);await name.fill('Con error');await save.click();await page.getByText('Fallo simulado',{exact:false}).waitFor();assert.equal(await name.inputValue(),'Con error');assert.equal(await page.getByRole('button',{name:'Abrir simulación: Con error',exact:true}).count(),0);
 await page.evaluate(()=>window.renderOperation('op2'));await page.getByRole('heading',{name:'Escenarios guardados'}).waitFor();assert.equal(await name.inputValue(),'');assert.equal(await page.getByRole('button',{name:'Abrir simulación: Copia A',exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: mobile 390px, copy/double click, cancel, snapshots, comparison, legacy/null values, refresh error, save error, operation change, no external network. Screenshot /tmp/saved-scenarios-mobile.png');
} finally {await browser?.close();await server.close();}
