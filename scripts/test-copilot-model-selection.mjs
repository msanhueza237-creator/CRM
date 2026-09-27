import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copilotConfig } from '../supabase/functions/crm-copilot/config.ts';
import { modelCatalog, chooseModel, selectedModelRouter } from '../supabase/functions/crm-copilot/model-selection.ts';
import { DeepSeekRouter } from '../supabase/functions/crm-copilot/deepseek-router.ts';
import { encryptApiKey } from '../supabase/functions/prospecting-integrations/deepseek.ts';
import { runOrchestrator } from '../supabase/functions/crm-copilot/orchestrator.ts';
import { runAgentManager } from '../supabase/functions/crm-copilot/agent-manager.ts';
import { readResult } from '../supabase/functions/crm-copilot/contracts.ts';
import { centralHandler } from '../supabase/functions/crm-copilot/central.ts';

const secret = 'fixture-encryption-secret-not-production-123456789';
const key = 'sk-fixture-private-deepseek-key';
const config = (extra = {}) => copilotConfig(k => ({ PROSPECTING_SECRET_ENCRYPTION_KEY: secret, ...extra })[k]);
const integration = { status: 'verified', models: ['deepseek-flash', 'deepseek-v4-pro', 'unapproved-model'] };
const context = { requestId: 'fixture', userId: 'user', conversationId: 'session', role: 'administrador', message: 'Consulta' };
const signal = () => new AbortController().signal;
const input = () => ({ instructions: 'Solo datos verificados.', input: [{ role: 'user', content: 'Stock?' }], tools: [], tool_choice: 'none', max_output_tokens: 512 });
const answer = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 20 } });
const call = (name, args = {}) => ({ status: 'completed', output: [{ type: 'function_call', call_id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 20 } });
const result = () => readResult('search_products', 'products', 'SKU QA: 8 unidades', { records: [{ sku: 'QA', stock: 8, stock_known: true }] }, [{ label: 'CRM', path: '/dashboard', entityType: 'product' }]);
const runtime = (fetcher, audit = async () => {}, env = {}) => new DeepSeekRouter(config(env).modelPolicy, 'deepseek-v4-pro', key, { input: 1.32, output: 3.96 }, audit, fetcher);

test('Catalogo permite solo modelos configurados y verificados, sin credenciales', async () => {
  const paths = [];
  const catalog = await modelCatalog({ select: async path => { paths.push(path); return [integration]; } }, config({ OPENAI_API_KEY: 'private-openai' }));
  assert.equal(catalog.defaultId, 'deepseek:deepseek-v4-pro');
  assert.deepEqual(catalog.models.map(m => m.id), ['deepseek:deepseek-v4-pro', 'deepseek:deepseek-flash', 'openai:default', 'openai:auto', 'openai:review']);
  assert.ok(!paths[0].includes('api_key')); assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.ok(!JSON.stringify(catalog).includes('private-openai'));
});
test('La seleccion explicita manda sobre sesion; un modelo retirado no cambia de proveedor', () => {
  const catalog = { models: [{ id: 'A' }, { id: 'B' }], defaultId: 'A' };
  assert.equal(chooseModel(catalog).id, 'A');
  assert.equal(chooseModel(catalog, undefined, 'B').id, 'B');
  assert.equal(chooseModel(catalog, 'A', 'B').id, 'A');
  for (const invalid of ['https://evil.invalid', '', null, {}, 'sk-fixture', 'C']) assert.throws(() => chooseModel(catalog, invalid), e => e.code === 'MODEL_UNAVAILABLE');
});
test('DeepSeek desconectado o error de almacen no se anuncia disponible', async () => {
  for (const source of [{ select: async () => [{ ...integration, status: 'disconnected' }] }, { select: async () => { throw Error('private'); } }]) {
    const catalog = await modelCatalog(source, config());
    assert.equal(catalog.models.length, 0);
    assert.throws(() => chooseModel(catalog), e => e.code === 'MODEL_UNAVAILABLE');
    assert.ok(!JSON.stringify(catalog).includes('private'));
  }
});
test('Modelos futuros requieren configuracion central y verificacion de cuenta', async () => {
  const settings = config({ COPILOT_DEEPSEEK_MODELS: 'future-model', COPILOT_DEFAULT_MODEL_CHOICE: 'deepseek:future-model', COPILOT_DEEPSEEK_RATES_JSON: '{"future-model":{"input":1,"output":2}}' });
  const catalog = await modelCatalog({ select: async () => [{ status: 'verified', models: ['future-model'] }] }, settings);
  assert.equal(chooseModel(catalog).model, 'future-model');
  assert.equal(settings.deepseek.rates['future-model'].output, 2);
});
test('Reutiliza clave cifrada; revalida desconexion antes de llamar al proveedor', async () => {
  const encrypted = await encryptApiKey(key, secret);
  const audit = [], source = { select: async () => [{ ...integration, api_key_encrypted: encrypted }], request: async (_, init) => { audit.push(JSON.parse(init.body)); } };
  const choice = { id: 'deepseek:deepseek-flash', model: 'deepseek-flash', provider: 'deepseek' };
  const router = await selectedModelRouter(source, config(), choice, context, async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/responses');
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.ok(!init.body.includes(key));
    return Response.json(answer('Datos verificados.'));
  });
  await router.call(input(), 'executive', signal());
  assert.equal(audit.length, 2); assert.ok(!JSON.stringify(audit).includes(key)); assert.ok(!JSON.stringify(audit).includes(encrypted));
  source.select = async () => [{ ...integration, status: 'disconnected', api_key_encrypted: encrypted }];
  await assert.rejects(selectedModelRouter(source, config(), choice, context), e => e.code === 'MODEL_UNAVAILABLE');
});
test('DeepSeek reutiliza herramientas y respuestas estructuradas del orquestador', async () => {
  const sent = [], traces = [], audit = [];
  const router = runtime(async (_, init) => {
    const request = JSON.parse(init.body); sent.push(request);
    return Response.json(sent.length === 1 ? call('search_products', { query: 'QA' }) : answer('Hay 8 unidades registradas.'));
  }, async data => audit.push(data));
  const output = await runOrchestrator({ modelRouter: router, registry: { list: () => [{ name: 'search_products', parameters: {}, description: 'Stock' }], execute: async () => result() }, model: 'ignored', apiKey: '', message: 'Stock QA', history: [], signal: signal(), onTrace: async t => traces.push(t) });
  assert.equal(output.model, 'deepseek-v4-pro'); assert.equal(output.results[0].data.records[0].stock, 8);
  assert.equal(traces.length, 1); assert.equal(sent[0].reasoning.effort, 'none');
  assert.ok(sent.every(r => r.reasoning.effort === 'none'));
  assert.equal(sent[1].input.filter(i => i.type === 'function_call_output').length, 1);
  assert.ok(sent.every(r => r.model === 'deepseek-v4-pro' && !('include' in r) && !('previous_response_id' in r)));
  assert.equal(audit.filter(r => r.status === 'ok').length, 2);
  assert.equal(await router.escalate(), null);
});
test('Gerente y especialista usan el mismo DeepSeek con limites compartidos', async () => {
  const sent = [], runs = [];
  const router = runtime(async (_, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    const specialist = b.instructions.includes('ROL DE ESTE TURNO: especialista');
    const done = b.input.some(i => i.type === 'function_call_output');
    return Response.json(specialist ? done ? answer('8 unidades') : call('search_products', { query: 'QA' }) : done ? answer('Stock registrado: 8 unidades') : call('consult_logistics', { question: 'Stock QA' }));
  });
  const output = await runAgentManager({ modelRouter: router, model: 'ignored', apiKey: '', message: 'Stock QA', history: [], signal: signal(),
    context: { ...context, sessionId: 'session', timestamp: new Date().toISOString(), companyId: null, permissions: ['products'], intent: 'stock' }, specialistTimeoutMs: 1000,
    registry: { list: () => [{ name: 'search_products', domain: 'products', parameters: {}, description: 'Stock' }], execute: async () => result() }, onTrace: async () => {}, onAgentRun: async run => runs.push(run) });
  assert.equal(sent.length, 4); assert.ok(sent.every(b => b.model === 'deepseek-v4-pro'));
  assert.ok(output.results.some(r => r.toolName === 'search_products'));
  assert.ok(runs.some(r => r.agent === 'logistics')); assert.ok(runs.some(r => r.agent === 'executive'));
});
test('Errores y cancelacion no reintentan ni revelan cuerpos privados', async () => {
  for (const status of [401, 402, 429, 500]) {
    let calls = 0;
    const router = runtime(async () => { calls++; return new Response('private secret', { status }); });
    await assert.rejects(router.call(input(), 'executive', signal()), e => !e.message.includes('private'));
    assert.equal(calls, 1);
    if ([401, 402].includes(status)) { await assert.rejects(router.call(input(), 'finance', signal())); assert.equal(calls, 1); }
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime(async () => assert.fail('No API')).call(input(), 'executive', controller.signal), e => e.name === 'AbortError');
});
test('Auditoria fallida bloquea proveedor y consumo desconocido no se factura como cero', async () => {
  await assert.rejects(runtime(async () => assert.fail('No API'), async () => { throw Error('private'); }).call(input(), 'executive', signal()), e => e.code === 'AI_AUDIT_UNAVAILABLE');
  const audit = [];
  await runtime(async () => Response.json({ ...answer('OK'), usage: {} }), async r => audit.push(r)).call(input(), 'executive', signal());
  assert.equal(audit.at(-1).estimatedCost, null); assert.equal(audit.at(-1).usageKnown, false);
});
test('Seleccion OpenAI conserva politica de presupuesto y no escala si se elige modelo base', async () => {
  const settings = config({ OPENAI_API_KEY: 'fixture', DAILY_OPENAI_BUDGET_USD: '5' });
  const source = { config: { url: 'https://fixture.invalid', serviceRoleKey: 'fixture' } };
  const router = await selectedModelRouter(source, settings, { id: 'openai:default', provider: 'openai' }, context, async () => assert.fail('No API'));
  assert.equal(router.policy.dailyBudgetUsd, 5); assert.equal(router.policy.mode, 'luna_only');
  assert.equal(await router.escalate({}, 'executive', signal(), '', [], false), null);
  const review = await selectedModelRouter(source, settings, { id: 'openai:review', provider: 'openai' }, context, async () => assert.fail('No API'));
  assert.equal(review.manualSol, true); assert.equal(review.policy.maxSolCalls, 1); assert.equal(review.policy.dailyBudgetUsd, 5);
  const catalog = await modelCatalog({ select: async () => [integration] }, config({ OPENAI_API_KEY: 'fixture', OPENAI_MODEL_MODE: 'luna_only' }));
  assert.ok(!catalog.models.some(m => m.id === 'openai:review'));
});
test('Endpoint DeepSeek funciona sin OpenAI, guarda seleccion y no modifica datos del negocio', async () => {
  const originalFetch = globalThis.fetch, originalDeno = globalThis.Deno;
  const writes = [], id = '11111111-1111-4111-8111-111111111111';
  const encrypted = await encryptApiKey(key, secret);
  globalThis.Deno = { env: { get: k => ({ PROSPECTING_SECRET_ENCRYPTION_KEY: secret, COPILOT_AGENT_MANAGER_ENABLED: 'false' })[k] } };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : {};
    assert.notEqual(u.hostname, 'api.openai.com');
    if (u.hostname === 'api.deepseek.com') return Response.json(body.input.some(i => i.type === 'function_call_output') ? answer('Sin publicaciones programadas.') : call('get_content', { view: 'scheduled', period: 'all' }));
    if (u.pathname.endsWith('/prospecting_ai_integrations')) return Response.json([{ ...integration, api_key_encrypted: encrypted }]);
    if (init.method && init.method !== 'GET') {
      assert.ok(u.pathname.includes('/copilot_')); writes.push(body);
      return Response.json([{ id, created_at: new Date().toISOString(), ...body }]);
    }
    return Response.json([], { headers: { 'content-range': '*/0' } });
  };
  try {
    const response = await centralHandler(new Request('https://fixture.invalid/message', { method: 'POST', body: JSON.stringify({ message: 'Que publicamos?', modelChoice: 'deepseek:deepseek-flash' }) }),
      { url: 'https://fixture.invalid', serviceRoleKey: 'fixture', anonKey: 'fixture' }, { id, role: 'administrador', accessToken: 'fixture' }, 'trace', {});
    const body = await response.json();
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.provider, 'deepseek');
    assert.ok(writes.some(w => w.metadata?.modelChoice === 'deepseek:deepseek-flash' && w.metadata?.engine === 'central'));
    assert.ok(!JSON.stringify({ body, writes }).includes(key)); assert.ok(!JSON.stringify({ body, writes }).includes(encrypted));
  } finally { globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; }
});
test('Texto y voz envian la misma seleccion sin secretos en frontend', () => {
  const hook = readFileSync(new URL('../src/modules/copilot/useCopilotLive.ts', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/modules/copilot/CentralCopilotPage.tsx', import.meta.url), 'utf8');
  assert.match(hook, /selectedModel.current,/); assert.match(ui, /undefined,\s+modelChoice,/);
  assert.match(ui, /busy \|\| historyBusy \|\| live.active \|\| voiceMode/);
  assert.ok(!/DEEPSEEK_API_KEY|PROSPECTING_SECRET_ENCRYPTION_KEY/.test(ui + hook));
});
