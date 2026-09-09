import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import { executiveDailySlot, buildExecutiveDailyBrief } from '../supabase/functions/crm-agent/executive-daily.ts';
test('Noon uses Chile DST, no early send or previous UTC date confusion', () => {
  assert.equal(executiveDailySlot(new Date('2026-09-09T14:59:59Z')).due, false);
  assert.deepEqual(executiveDailySlot(new Date('2026-09-09T15:00:00Z')), { day:'2026-09-09', key:'executive:2026-09-09:1200', due:true, scheduledFor:'2026-09-09T15:00:00.000Z' });
  assert.equal(executiveDailySlot(new Date('2026-07-09T16:00:00Z')).scheduledFor, '2026-07-09T16:00:00.000Z');
  assert.equal(executiveDailySlot(new Date('2026-09-10T01:00:00Z')).day, '2026-09-09');
  assert.equal(executiveDailySlot(new Date('2026-09-09T23:00:00Z')).due, false);
});
test('Brief selects at most five priorities, preserves unknowns and dates, no simulated shipment alarms', () => {
  const r = buildExecutiveDailyBrief({ metrics:{ verified_receivables_available:false, stock_unknown:20, failed_publications:3, pending_approval:5, overdue_amount:100, operating_profit:-200, followups_overdue:30 }, accounting:{ provisional:true, period:{from:'2026-01-01',to:'2026-09-09'} }, sections:[{key:'operations',rows:[{operation_type:'simulation',status:'in_transit',estimated_arrival:'2026-09-01',title:'SIMULACION'}]}] }, null, '2026-09-09T15:00:00Z');
  assert.equal(r.sections[0].items.length, 5);
  assert.doesNotMatch(JSON.stringify(r), /SIMULACION/);
  assert.match(JSON.stringify(r), /No disponible/);
  assert.match(JSON.stringify(r), /provisional/);
  assert.ok(r.omitted_priorities > 0);
});
test('Changes compare module amounts only, not mismatched sales periods', () => {
  const previous={metrics:{net_sales:100, receivables:200},accounting:{period:{from:'2025-01-01'},basis:'ledger'}};
  const current={metrics:{net_sales:1000,receivables:50,verified_receivables_available:true},accounting:{period:{from:'2026-01-01'},basis:'ledger',source_as_of:'2026-09-09'}};
  const r=buildExecutiveDailyBrief(current,previous,'2026-09-09T15:00:00Z');
  const changes=r.sections.find(s=>s.key==='changes').items;
  assert.equal(changes.length,1); assert.equal(changes[0].title,'Cartera por cobrar');
});
test('Email uses CLIMACTIVA/noon and safe module links without a real send', async () => {
  const source=await readFile('supabase/functions/gmail-integration/index.ts','utf8');
  const tree=ts.createSourceFile('gmail.ts',source,ts.ScriptTarget.Latest,true);
  const names=['handleExecutiveBrief','formatExecutiveItem','escapeExecutiveHtml'];
  const text=tree.statements.filter(n=>names.includes(n.name?.text)).map(n=>n.getText(tree)).join('\n');
  const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let sent;
  const obj=v=>v&&typeof v==='object'?v:{};
  const handler=new Function('asObject','HttpError','requiredEnv','sendTrackedEmail','json',`${code};return handleExecutiveBrief`)(obj,Error,()=> 'sender@example.test',async(_db,input)=>{sent=input;return {gmailMessageId:'mock'}},data=>data);
  const db={from:()=>({select:()=>({eq:()=>({limit:()=>({maybeSingle:async()=>({data:{id:'admin'},error:null})})})})})};
  await handler(new Request('http://test',{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify({recipient:'owner@example.test',result:{evidence:[{executive_brief:{mode:'daily',headline:'Prioridades',sections:[{title:'Finanzas',items:[{title:'Cartera',detail:'Con respaldo',href:'/finanzas-contabilidad?view=receivables'},{title:'Texto no confiable',href:'//evil.test'}]}]}}]}})}),db,'test');
  assert.equal(sent.subject,'CLIMACTIVA · Informe diario 12:00');
  assert.match(sent.bodyHtml,/https:\/\/crm.latinchile.cl\/finanzas-contabilidad\?view=receivables/);
  assert.doesNotMatch(sent.bodyHtml,/evil.test|08:30|CLIMA ACTIVA/);
});
test('Database daily gate rejects old slots, duplicate schedules, past queue and repeat delivery', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION public.test_now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT current_setting('test.clock')::timestamptz $$;
      SET test.clock='2026-09-09T15:00:00Z';
      CREATE TABLE executive_agent_settings(id text,timezone text,morning_time time,cutoff_time time,review_interval_hours int,only_relevant_after_morning bool,updated_at timestamptz);
      INSERT INTO executive_agent_settings(id) VALUES('default');
      CREATE TABLE business_agent_tasks(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,agent_type text,action text,payload jsonb,status text,priority int,requested_by uuid);
      CREATE TABLE executive_schedule_slots(slot_key text UNIQUE,scheduled_for timestamptz,slot_kind text,task_id uuid,snapshot_keys jsonb);
      CREATE TABLE executive_notifications(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,task_id uuid,channel text,status text DEFAULT 'pending',attempts int DEFAULT 0,next_attempt_at timestamptz DEFAULT '2026-09-09T15:00:00Z',created_at timestamptz DEFAULT '2026-09-09T15:00:00Z',updated_at timestamptz,sent_at timestamptz,error text);
    `);
    const sql=(await readFile('supabase/executive_daily_noon.sql','utf8')).replace(/\bnow\(\)/g,'public.test_now()');
    await db.exec(sql);
    const schedule=async (day='2026-09-09', mode='daily') => (await db.query(`select schedule_executive_agent_task($1,$2,'morning',$3::jsonb) id`,[`executive:${day}:1200`,`${day}T15:00:00Z`,JSON.stringify({mode,report_date:day,delivery:{auto_send:true}})])).rows[0].id;
    assert.equal(await schedule('2026-09-09','review'), null);
    await db.exec(`SET test.clock='2026-09-09T14:59:59Z'`); assert.equal(await schedule(),null);
    await db.exec(`SET test.clock='2026-09-09T15:00:00Z'`);
    const id=await schedule(); assert.ok(id); assert.equal(await schedule(),id);
    await db.query(`UPDATE business_agent_tasks SET status='completed' WHERE id=$1`,[id]);
    await db.query(`INSERT INTO executive_notifications(task_id,channel) VALUES($1,'email')`,[id]);
    const first=await db.query('SELECT * FROM claim_executive_notification()'); assert.equal(first.rows.length,1);
    assert.equal((await db.query('SELECT * FROM claim_executive_notification()')).rows.length,0);
    await db.exec(`UPDATE executive_notifications SET status='failed'`);
    assert.equal((await db.query('SELECT * FROM claim_executive_notification()')).rows.length,0,'No blind retry after uncertain delivery');
    await db.exec(`SET test.clock='2026-09-10T15:00:00Z'`);
    await db.query('SELECT * FROM claim_executive_notification()');
    assert.equal((await db.query('SELECT status FROM executive_notifications')).rows[0].status,'skipped');
    const tomorrow=await schedule('2026-09-10'); assert.ok(tomorrow);
    await db.exec(`DELETE FROM executive_schedule_slots WHERE slot_key='executive:2026-09-10:1200'; UPDATE executive_notifications SET status='sent',sent_at='2026-09-10T14:00:00Z'`);
    assert.equal(await schedule('2026-09-10'),null,'Already sent legacy mail counts against daily allowance');
  } finally { await db.close(); }
});
