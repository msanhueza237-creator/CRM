import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base=process.env.LOANS_UI_URL || 'http://127.0.0.1:53702';
const env=await readFile(new URL('../.env.local',import.meta.url),'utf8');
const url=env.match(/^VITE_SUPABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1], origin=new URL(url).origin;
const user={id:'22222222-2222-4222-8222-222222222222',email:'qa@example.invalid',aud:'authenticated',role:'authenticated',user_metadata:{full_name:'Prueba',role:'administrador'}};
const accounts=[['bank','Scotiabank CLP','bank_scotiabank_clp','asset'],['loan','Prestamo de socia','loan_payable','liability'],['suspense','Transitoria pasivos','suspense_liability','liability']].map(([id,name,classification,account_type])=>({id,name,classification,account_type,currency:'CLP',active:true,allows_posting:true,code:id}));
const bankTransactions=[{id:'incoming',amount_clp:5000000,amount:5000000,transaction_date:'2026-09-11',description:'TEF PRESTAMISTA',bank_account_id:'bank',currency:'CLP',reconciliation_status:'unmatched',metadata:{}},{id:'payment',amount_clp:-1000000,amount:-1000000,transaction_date:'2026-09-15',description:'DEVOLUCION CAPITAL',bank_account_id:'bank',currency:'CLP',reconciliation_status:'unmatched',metadata:{}}];
const bootstrap={entity:{id:'entity',name:'Prueba'},profile:{role:'administrador',permissions:[]},accounts,bankAccounts:[{id:'bank',institution:'Scotiabank',currency:'CLP',active:true}],bankTransactions,periods:[],entries:[],sources:[],receivables:[],payables:[],checks:[],controls:[],batches:[],paymentEvents:[],bankBalanceSnapshots:[],factoSyncRuns:[],factoReceivableSyncRuns:[],factoFreshness:{stale:false},summary:{},dashboard:{}};
const browser=await chromium.launch({headless:true,channel:'chrome'});
await mkdir('outputs/loans',{recursive:true});
try {
  const context=await browser.newContext();
  const payload=Buffer.from(JSON.stringify({sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');
  await context.addInitScript(({key,user,payload})=>localStorage.setItem(key,JSON.stringify({access_token:`eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`,refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+86400,expires_in:86400,token_type:'bearer',user})),{key:`sb-${new URL(url).hostname.split('.')[0]}-auth-token`,user,payload});
  let loans=[], failRead=false, failPost=false;
  const calls=[], errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());
    if(u.origin!==origin)return u.origin===new URL(base).origin?route.continue():route.abort();
    const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
    let body=[];
    if(u.pathname.includes('/profiles'))body={...user,role:'administrador',full_name:'Prueba',active:true};
    if(u.pathname.endsWith('/auth/v1/user'))body=user;
    if(u.pathname.endsWith('/bootstrap'))body=bootstrap;
    if(u.pathname.endsWith('/loans')){
      if(failRead)return route.fulfill({status:503,headers,body:JSON.stringify({error:'Sin conexion con prestamos'})});
      body={loans};
    }
    if(u.pathname.includes('/loans/')){
      calls.push(u.pathname.split('/').at(-1));const input=request.postDataJSON();
      if(u.pathname.endsWith('/save')){loans=[{...input,accounting_loan_movements:[]}];body={id:input.id};}
      else {
        const tx=bankTransactions.find(t=>t.id===input.transactionId),amount=Math.abs(tx.amount_clp);
        body={loanId:input.loanId,existing:false,amountClp:amount,date:tx.transaction_date,staged:true,balanceAfter:input.kind==='received'?amount:4000000,lines:[{account_id:'suspense',debit_clp:amount,credit_clp:0},{account_id:'loan',debit_clp:0,credit_clp:amount}]};
        if(u.pathname.endsWith('/post')){
          if(failPost)return route.fulfill({status:409,headers,body:JSON.stringify({error:'Periodo cerrado. No se contabilizo.'})});
          loans[0].accounting_loan_movements.push({id:`movement-${calls.length}`,kind:input.kind,amount_clp:amount,bank_transaction_id:tx.id,entry_id:`entry-${calls.length}`,accounting_journal_entries:{entry_date:tx.transaction_date,entry_number:calls.length,status:'posted'}});
          tx.reconciliation_status='matched';body.entryId=`entry-${calls.length}`;
        }
      }
    }
    return route.fulfill({status:200,headers,body:JSON.stringify(body)});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/finanzas-contabilidad?view=loans`);
  const root=page.locator('.loans-view');
  await root.getByRole('button',{name:'Nuevo préstamo'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Prestamista',{exact:true}).fill('Sisla Muñoz');
  await dialog.getByLabel('Capital CLP').fill('5000000');
  await dialog.getByLabel('Fecha de recepción').fill('2026-09-11');
  await dialog.getByLabel('Devolución acordada').fill('2026-09-30');
  await dialog.getByLabel('Destino del dinero').fill('Pago invoice internacional');
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:950});
    assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+2),false,`dialog overflow ${width}`);
    await page.screenshot({path:`outputs/loans/form-${width}.png`});
  }
  await dialog.getByRole('button',{name:'Guardar borrador'}).click();
  await root.getByRole('button',{name:'Contabilizar ingreso'}).waitFor();
  assert.deepEqual(calls,['save']);assert.match(await root.locator('.loan-totals').innerText(),/\$0/);
  await root.getByRole('button',{name:'Contabilizar ingreso'}).click();
  await dialog.getByLabel('Movimiento de cartola').selectOption('incoming');
  await dialog.getByRole('button',{name:'Revisar asiento'}).click();
  await dialog.getByRole('button',{name:'Confirmar asiento'}).waitFor();
  assert.deepEqual(calls,['save','preview']);assert.equal(loans[0].accounting_loan_movements.length,0);
  assert.match(await dialog.innerText(),/Reclasificación/);
  failPost=true;await dialog.getByRole('button',{name:'Confirmar asiento'}).click();
  await dialog.getByRole('alert').waitFor();assert.equal(loans[0].accounting_loan_movements.length,0);
  failPost=false;await dialog.getByRole('button',{name:'Confirmar asiento'}).click();
  await root.getByRole('button',{name:'Registrar abono de capital'}).waitFor();
  assert.equal(loans[0].accounting_loan_movements.length,1);
  await root.getByRole('button',{name:'Registrar abono de capital'}).click();
  await dialog.getByLabel('Movimiento de cartola').selectOption('payment');
  await dialog.getByRole('button',{name:'Revisar asiento'}).click();
  await dialog.getByRole('button',{name:'Confirmar asiento'}).click();
  await root.getByRole('button',{name:'Registrar abono de capital'}).waitFor();
  await page.waitForLoadState('networkidle');
  await root.locator('.loan-totals').getByText('$4.000.000',{exact:true}).waitFor();
  assert.match(await root.locator('.loan-totals').innerText(),/4\.000\.000/);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:950});await root.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,`page overflow ${width}`);
    await page.screenshot({path:`outputs/loans/detail-${width}.png`,fullPage:true});
  }
  await root.getByLabel('Prestamista o destino').fill('no existente');
  await root.getByText('No hay préstamos para estos filtros.').waitFor();
  await root.getByLabel('Prestamista o destino').fill('');
  failRead=true;await root.getByRole('button',{name:'Actualizar préstamos'}).click();
  await root.getByRole('alert').waitFor();assert.equal(await root.locator('.loan-totals').getByText('No disponible').count(),3);
  failRead=false;await root.getByRole('button',{name:'Actualizar préstamos'}).click();
  await root.getByRole('button',{name:'Registrar abono de capital'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS loans UI: draft, preview without posting, error/retry, receipt, repayment, filters, unavailable amounts, desktop/mobile layouts. All API requests mocked; no production writes.');
} finally {await browser.close();}
