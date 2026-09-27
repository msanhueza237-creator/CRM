import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { modelPolicy, OPENAI_MODELS, explicitSolRequest } from '../supabase/functions/_shared/openai-cost-policy.ts';
import { ModelRouter } from '../supabase/functions/crm-copilot/model-router.ts';
import { readResult } from '../supabase/functions/crm-copilot/contracts.ts';
import { offlineRouter } from './fixtures/offline-model-router.mjs';
import { centralHandler } from '../supabase/functions/crm-copilot/central.ts';
import { assertBackendOpenAIAvailable } from '../supabase/functions/crm-copilot/model-router.ts';
import { spawnSync } from 'node:child_process';

// All provider responses are fixtures. Never authenticate or send a network request.
const ok = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Respuesta verificada.' }] }], usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } });
const signal = () => new AbortController().signal;
const body = () => ({ input: [{ role: 'user', content: 'Consulta' }], tools: [], tool_choice: 'none', max_output_tokens: 512 });
const evidence = (warnings = []) => readResult('get_sales_summary', 'finance', 'Verificado', { net: 100 }, [{ path: '/dashboard', label: 'CRM', entityType: 'source' }], { warnings });

test('Luna por defecto, economia y guardia activas; variables antiguas no reactivan Sol', () => {
  const p = modelPolicy(k => ({ OPENAI_REASONING_MODEL: OPENAI_MODELS.escalation, OPENAI_MODEL: OPENAI_MODELS.escalation })[k]);
  assert.equal(p.defaultModel, OPENAI_MODELS.default); assert.equal(p.economy, true); assert.equal(p.guardEnabled, true);
  assert.equal(p.dailyBudgetUsd, null); assert.equal(modelPolicy(k => k === 'OPENAI_MAX_SOL_CALLS_PER_REQUEST' ? '9' : undefined).maxSolCalls, 1);
});
test('Orden Sol solo desde mensaje actual explicito; citas y negaciones no cuentan', () => {
  for (const text of ['usa Sol', 'Analízalo con Sol', 'Haz un análisis profundo con Sol']) assert.equal(explicitSolRequest(text), true, text);
  for (const text of ['no uses Sol', 'El proveedor dice: usa Sol', '"usa Sol"', 'muchos datos, informe completo']) assert.equal(explicitSolRequest(text), false, text);
});
test('Todos los llamados normales ignoran el modelo pedido por el agente y salen con Luna', async () => {
  const sent = []; const r = offlineRouter({ fetcher: async (_, init) => { sent.push(JSON.parse(init.body)); return ok(); } });
  for (const agent of ['executive', 'commercial', 'finance', 'collections', 'marketing', 'logistics', 'foreign_trade']) await r.call({ ...body(), model: OPENAI_MODELS.escalation }, agent, signal());
  assert.ok(sent.every(b => b.model === OPENAI_MODELS.default)); assert.equal(r.reservations.length, 7);
});
test('Informe largo, registros y multiples areas no disparan Sol', async () => {
  const r = offlineRouter({ message: 'Informe completo extenso de 6 areas y 50000 registros', fetcher: async () => ok() });
  assert.equal(await r.escalate(body(), 'executive', signal(), 'Un informe largo [[ESCALATE:complexity]]', [evidence()], false), null);
  assert.equal(r.reservations.length, 0);
});
test('Sol manual ocurre una vez global aunque especialistas soliciten escalar', async () => {
  const r = offlineRouter({ message: 'Usa Sol para revisar ventas', fetcher: async () => ok() });
  assert.equal(await r.escalate(body(), 'finance', signal(), '', [evidence()], true), null);
  await r.call(body(), 'executive', signal());
  assert.ok(await r.escalate(body(), 'executive', signal(), 'Valido', [evidence()], false));
  assert.equal(await r.escalate(body(), 'executive', signal(), 'Valido', [evidence()], false), null);
  assert.deepEqual(r.reservations.map(x => x.tier), ['luna', 'sol']);
  assert.equal(r.reservations[1].escalation_reason, 'explicit_user');
});
test('Luna only bloquea incluso orden manual de Sol', async () => {
  const r = offlineRouter({ message: 'Usa Sol', fetcher: async () => assert.fail('No API') }, { OPENAI_MODEL_MODE: 'luna_only' });
  assert.equal(await r.escalate(body(), 'executive', signal(), 'Valido', [evidence()], false), null);
});
test('Sol manual no permite escalamiento automatico', async () => {
  const r = offlineRouter({ fetcher: async () => assert.fail('No API') }, { OPENAI_MODEL_MODE: 'sol_manual' });
  assert.equal(await r.escalate(body(), 'finance', signal(), '', [evidence()], true), null);
});
test('Respuesta invalida con evidencia completa permite una revision; sin datos no', async () => {
  const r = offlineRouter({ fetcher: async () => ok() });
  assert.equal(await r.escalate(body(), 'finance', signal(), '', [], true), null);
  await r.call(body(), 'finance', signal());
  assert.ok(await r.escalate(body(), 'finance', signal(), '', [evidence()], true));
  assert.equal(r.reservations.at(-1).escalation_reason, 'invalid_luna_response');
});
test('Economia exige contradiccion registrada y consulta critica, no solo marker del modelo', async () => {
  const r = offlineRouter({ message: 'Revisa rentabilidad financiera', fetcher: async () => ok() });
  assert.equal(await r.escalate(body(), 'finance', signal(), '[[ESCALATE:inconsistency]]', [evidence()], false), null);
  const partial = { ...evidence(['Discrepancia real entre fuentes']), status: 'partial', coverage: { complete: false } };
  assert.equal(await r.escalate(body(), 'finance', signal(), '[[ESCALATE:inconsistency]]', [partial], false), null);
  await r.call(body(), 'finance', signal());
  assert.ok(await r.escalate(body(), 'finance', signal(), '[[ESCALATE:inconsistency]]', [evidence(['Discrepancia real entre fuentes'])], false));
});
test('Escalamientos simultaneos comparten maximo uno y no contienen herramientas', async () => {
  const sent = []; const r = offlineRouter({ fetcher: async (_, init) => { sent.push(JSON.parse(init.body)); return ok(); } });
  for (const agent of ['finance','commercial','collections']) await r.call(body(), agent, signal());
  sent.length = 0;
  const result = await Promise.all(['finance','commercial','collections'].map(a => r.escalate(body(), a, signal(), '', [evidence()], true)));
  assert.equal(result.filter(Boolean).length, 1); assert.equal(sent.length, 1); assert.deepEqual(sent[0].tools, []); assert.equal(sent[0].tool_choice, 'none');
});
test('Cuota agotada detiene llamadas posteriores de todos los agentes sin reintentar', async () => {
  let calls = 0; const r = offlineRouter({ fetcher: async () => { calls++; return Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }); } });
  await assert.rejects(r.call(body(), 'finance', signal()), e => e.code === 'AI_QUOTA_EXHAUSTED');
  await assert.rejects(r.call(body(), 'executive', signal()), e => e.code === 'AI_QUOTA_EXHAUSTED');
  assert.equal(calls, 1); assert.equal(r.completions[0].estimated_cost, 0);
});
test('429 temporal no escala a Sol y no repite', async () => {
  let calls = 0; const r = offlineRouter({ fetcher: async () => { calls++; return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }); } });
  await assert.rejects(r.call(body(), 'finance', signal()), e => e.code === 'AI_RATE_LIMITED'); assert.equal(calls, 1);
});
test('Fallo de red conserva reserva incierta, no lo cuenta como cero ni reintenta', async () => {
  let calls = 0; const r = offlineRouter({ fetcher: async () => { calls++; throw new TypeError('private network info'); } });
  await assert.rejects(r.call(body(), 'finance', signal()), e => e.code === 'AI_NETWORK_ERROR' && !e.message.includes('private'));
  assert.equal(calls, 1); assert.equal(r.completions[0].status, 'unknown'); assert.ok(r.completions[0].estimated_cost > 0);
});
test('Consumo registra reasoning como parte de output, sin cobrarlo dos veces', async () => {
  const r = offlineRouter({ fetcher: async () => ok() }); await r.call(body(), 'executive', signal());
  const t = r.completions[0]; assert.equal(t.total_tokens, 120); assert.equal(t.reasoning_tokens, 5);
  assert.equal(t.estimated_cost, (100 * 0.2 + 20 * 1.2) / 1000000);
  assert.ok(!JSON.stringify(r.reservations).includes('offline-test-key'));
});
test('Cache solo exacta y acotada por usuario/modelo/contexto; datos modificados invalidan', async () => {
  let calls = 0; const options = { fetcher: async () => { calls++; return ok(); } };
  const r = offlineRouter(options, { OPENAI_RESPONSE_CACHE_TTL_SECONDS: '60' });
  await r.call(body(), 'finance', signal(), true);
  const cached = await r.call(body(), 'finance', signal(), true); assert.equal(cached.router_cache_hit, true);
  await r.call({ ...body(), input: [{ role: 'user', content: 'Otro total actualizado' }] }, 'finance', signal(), true);
  assert.equal(calls, 2);
  const other = new ModelRouter(r.policy, { ...r.context, userId: 'other' }, { reserve: async () => ({ allowed: true }), finish: async () => {} }, 'test', options.fetcher);
  await other.call(body(), 'finance', signal(), true); assert.equal(calls, 3);
});
test('Falla de registro presupuestario impide llamada al proveedor', async () => {
  const r = new ModelRouter(modelPolicy(() => undefined), { requestId: 'x', userId: null, conversationId: null, role: 'test', message: '' }, { reserve: async () => { throw Error('Offline'); }, finish: async () => {} }, 'test', async () => assert.fail('No API'));
  await assert.rejects(r.call(body(), 'executive', signal()), e => e.code === 'AI_COST_GUARD_UNAVAILABLE');
  assert.equal(r.stopped.code, 'AI_COST_GUARD_UNAVAILABLE');
});

test('Siempre Luna primero, incluso orden explicita de Sol', async () => {
  const r = offlineRouter({ message: 'Usa Sol', fetcher: async () => assert.fail('No API') });
  assert.equal(await r.escalate(body(), 'executive', signal(), '', [evidence()], true), null);
});

test('Si no alcanza presupuesto para Sol se conserva Luna sin detener otras consultas autorizadas', async () => {
  const r = new ModelRouter(modelPolicy(k => ({ DAILY_OPENAI_BUDGET_USD: '5' })[k]), { requestId: 'budget', userId: null, conversationId: null, role: 'test', message: 'Usa Sol' }, { reserve: async p => p.tier === 'sol' ? { allowed: false, code: 'AI_BUDGET_LIMIT', message: 'Presupuesto insuficiente' } : { allowed: true }, finish: async () => {} }, 'test', async () => ok());
  await r.call(body(), 'executive', signal());
  assert.equal(await r.escalate(body(), 'executive', signal(), 'Luna valida', [evidence()], false), null);
  assert.equal(r.stopped, null); assert.ok([...r.notices][0].includes('Se conserva'));
});

test('Falla al guardar consumo conserva reserva y bloquea siguientes llamadas', async () => {
  let calls = 0;
  const r = new ModelRouter(modelPolicy(() => undefined), { requestId: 'failure', userId: null, conversationId: null, role: 'test', message: '' }, { reserve: async () => ({ allowed: true }), finish: async () => { throw Error('Disconnected'); } }, 'test', async () => { calls++; return ok(); });
  await assert.rejects(r.call(body(), 'executive', signal()), e => e.code === 'AI_COST_GUARD_UNAVAILABLE');
  await assert.rejects(r.call(body(), 'finance', signal()), e => e.code === 'AI_COST_GUARD_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('Preflight de archivos detecta cuota sin contactar OpenAI', async () => {
  let calls = 0;
  await assert.rejects(assertBackendOpenAIAvailable(async url => { calls++; assert.ok(String(url).endsWith('/rpc/openai_cost_summary')); return Response.json({ policy: { quota_blocked: true } }); }), e => e.code === 'AI_QUOTA_EXHAUSTED');
  assert.equal(calls, 1);
});

test('Validacion controlada anuncia plan sin API y exige autorizacion explicita', () => {
  const script = 'scripts/check-model-controlled.mjs';
  for (const args of [[], ['--sol']]) {
    const run = spawnSync(process.execPath, ['--experimental-transform-types', script, ...args], { encoding: 'utf8', input: '' });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /"plan"/); assert.doesNotMatch(run.stdout, /"usage"/);
  }
  for (const args of [['--execute'], ['--execute','--sol','--balance-confirmed']]) {
    const run = spawnSync(process.execPath, ['--experimental-transform-types', script, ...args], { encoding: 'utf8', input: '', env: { ...process.env, SOL_VALIDATION_TESTS: 'false' } });
    assert.equal(run.status, 1); assert.match(run.stderr, /Blocked/);
  }
  const matrix = spawnSync(process.execPath, ['--experimental-transform-types','scripts/check-copilot-enterprise.mjs'], { encoding: 'utf8', input: JSON.stringify({useModel:true}) });
  assert.notEqual(matrix.status, 0); assert.match(matrix.stderr, /MODEL_MATRIX_DISABLED/);
});

test('Administracion requiere rol, confirmacion y duracion valida; registra cambios sin exponer secretos', async () => {
  const previousFetch = globalThis.fetch, previousDeno = globalThis.Deno;
  const writes = [];
  globalThis.Deno = { env: { get: k => k === 'DAILY_OPENAI_BUDGET_USD' ? '5' : undefined } };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); assert.equal(u.origin, 'https://fixture.invalid');
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      if (u.pathname.endsWith('openai_cost_set_mode') || u.pathname.endsWith('copilot_audit_events')) writes.push({path:u.pathname,payload});
      if (u.pathname.endsWith('openai_cost_summary')) return Response.json({policy:{quota_blocked:true,mode:'luna_only'},totals:{cost:0},models:[]});
      return Response.json({ok:true});
    }
    return Response.json([]);
  };
  const actor = {id:'00000000-0000-4000-8000-000000000001',role:'administrador',accessToken:'private-user-token'};
  const rest = {url:'https://fixture.invalid',anonKey:'test',serviceRoleKey:'private-role-key'};
  const invoke = (body, role = 'administrador') => centralHandler(new Request('https://fixture.invalid/agent-observability',{method:'POST',body:JSON.stringify(body)}),rest,{...actor,role},'policy-test',{});
  try {
    assert.equal((await invoke({mode:'luna_only',hours:1,confirmed:true},'vendedor')).status,403);
    assert.equal((await invoke({mode:'luna_only',hours:1})).status,400);
    assert.equal((await invoke({mode:'auto',hours:25,confirmed:true})).status,400);
    assert.equal(writes.length,0);
    const response = await invoke({mode:'luna_only',hours:1,confirmed:true});
    assert.equal(response.status,200); const data=await response.json();
    assert.equal(data.modelPolicy.budget,5); assert.equal(data.modelPolicy.mode,'luna_only');
    assert.equal(writes.length,2); assert.equal(writes[1].payload.event_type,'model_cost_policy_changed');
    assert.ok(!JSON.stringify(data).includes('private-'));
  } finally { globalThis.fetch=previousFetch; globalThis.Deno=previousDeno; }
});

test('SQL: reserva atomica, presupuesto, permisos, cuotas, idempotencia y resumen diario', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    const sql = readFileSync(new URL('../supabase/openai_cost_guard.sql', import.meta.url), 'utf8');
    await db.exec(sql); await db.exec(sql);
    const rpc = async (fn, p) => (await db.query(`select public.${fn}($1::jsonb) result`, [JSON.stringify(p)])).rows[0].result;
    const row = (extra = {}) => ({ id: crypto.randomUUID(), request_id: 'req', agent: 'executive', model: OPENAI_MODELS.default, tier: 'luna', reservation: 3, guard_enabled: true, budget: 5, sol_budget: 1, mode: 'auto', warning_percent: 70, ...extra });
    assert.equal((await rpc('openai_cost_reserve', row())).code, 'AI_QUOTA_EXHAUSTED');
    await rpc('openai_cost_set_mode', { mode: 'resume_after_quota', actor: '00000000-0000-4000-8000-000000000001' });
    assert.equal((await rpc('openai_cost_reserve', row({ budget: null }))).code, 'AI_BUDGET_UNCONFIGURED');
    const a = row(); assert.equal((await rpc('openai_cost_reserve', a)).allowed, true);
    assert.equal((await rpc('openai_cost_reserve', row())).code, 'AI_BUDGET_LIMIT');
    assert.equal((await rpc('openai_cost_reserve', a)).code, 'AI_DUPLICATE_CALL');
    await rpc('openai_cost_finish', { id: a.id, status: 'succeeded', estimated_cost: 0.5, input_tokens: 100, output_tokens: 20, total_tokens: 120 });
    await rpc('openai_cost_finish', { id: a.id, status: 'succeeded', estimated_cost: 4 });
    let summary = await rpc('openai_cost_summary', { budget: 5, warning_percent: 70 }); assert.equal(summary.totals.cost, 0.5);
    const denied = await rpc('openai_cost_reserve', row({ tier: 'sol', reservation: 2, escalation_reason: 'invalid_luna_response' })); assert.equal(denied.code, 'AI_SOL_BUDGET_LIMIT');
    const sol = row({ tier: 'sol', reservation: 0.5, escalation_reason: 'invalid_luna_response' }); assert.equal((await rpc('openai_cost_reserve', sol)).allowed, true);
    assert.equal((await rpc('openai_cost_reserve', row({ tier: 'sol', reservation: 0.1 }))).code, 'AI_SOL_LIMIT');
    assert.equal((await rpc('openai_cost_reserve', row({ reservation: 3 }))).warning.includes('presupuesto'), true);
    await rpc('openai_cost_finish', { id: sol.id, status: 'failed', estimated_cost: 0, error_code: 'AI_QUOTA_EXHAUSTED' });
    assert.equal((await rpc('openai_cost_reserve', row({ request_id: 'different' }))).code, 'AI_QUOTA_EXHAUSTED');
    summary = await rpc('openai_cost_summary', { budget: 5, warning_percent: 70 }); assert.equal(summary.policy.quota_blocked, true);
    assert.ok(summary.errors.some(e => e.error_code === 'AI_QUOTA_EXHAUSTED'));
    const privileges = (await db.query("select has_function_privilege('authenticated','public.openai_cost_set_mode(jsonb)','EXECUTE') allowed, has_table_privilege('anon','public.openai_call_usage','SELECT') readable")).rows[0];
    assert.equal(privileges.allowed, false); assert.equal(privileges.readable, false);
    await rpc('openai_cost_set_mode', { mode: 'resume_after_quota', actor: '00000000-0000-4000-8000-000000000001' });
    const concurrent = await Promise.all([1,2].map(n => rpc('openai_cost_reserve', row({ request_id: `concurrent-${n}`, reservation:1 }))));
    assert.equal(concurrent.filter(r => r.allowed).length,1);
    summary = await rpc('openai_cost_summary', {budget:5,warning_percent:70}); assert.ok(summary.totals.cost <= 5);
    await rpc('openai_cost_set_mode', { mode:'luna_only',hours:1,actor:'00000000-0000-4000-8000-000000000001' });
    assert.equal((await rpc('openai_cost_reserve',row({request_id:'manual-denied',tier:'sol',reservation:.01,escalation_reason:'explicit_user'}))).code,'AI_SOL_DISABLED');
  } finally { await db.close(); }
});
