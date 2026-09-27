import assert from 'node:assert/strict';
import { modelPolicy, OPENAI_MODELS } from '../supabase/functions/_shared/openai-cost-policy.ts';
import { ModelRouter } from '../supabase/functions/crm-copilot/model-router.ts';
import { ModelCostStore } from '../supabase/functions/crm-copilot/model-cost-store.ts';
import { CopilotSources } from '../supabase/functions/crm-copilot/sources.ts';
import { ToolRegistry } from '../supabase/functions/crm-copilot/tool-registry.ts';
import { todayChile } from '../supabase/functions/crm-copilot/dates.ts';

const sol = process.argv.includes('--sol');
console.log(JSON.stringify({ plan: sol ? 'SOL_VALIDATION_TESTS' : 'ONE_LUNA_VALIDATION', models: sol ? [OPENAI_MODELS.default, OPENAI_MODELS.escalation] : [OPENAI_MODELS.default], maxCalls: sol ? 2 : 1, maxOutputTokens: 512, tool: 'get_sales_summary(this_month)', writes: 'cost telemetry only', retries: 0 }));
if (!process.argv.includes('--execute')) process.exit(0);
if (!process.argv.includes('--balance-confirmed') || (sol && process.env.SOL_VALIDATION_TESTS !== 'true')) {
  console.error('Blocked. Confirm API balance explicitly; Sol additionally requires SOL_VALIDATION_TESTS=true. No request sent.'); process.exit(1);
}

// Execute only on the trusted backend. Secrets arrive on stdin, never argv or logs.
let input = ''; for await (const chunk of process.stdin) input += chunk;
const settings = JSON.parse(input); input = '';
const env = key => settings.env?.[key];
const policy = { ...modelPolicy(env), defaultModel: OPENAI_MODELS.default, escalationModel: OPENAI_MODELS.escalation, mode: sol ? 'sol_manual' : 'luna_only', autoEscalation: false, guardEnabled: true, economy: true, outputTokens: 512, cacheTtlMs: 0, maxRequestCalls: sol ? 2 : 1 };
assert.ok(env('OPENAI_API_KEY') && policy.dailyBudgetUsd, 'Backend key and authorized daily budget required.');
assert.equal(settings.actor?.role, 'administrador', 'Administrator session required.');
const origin = new URL(settings.rest.url).origin;
const allowedRpc = new Set(['accounting_dashboard_summary','accounting_report','accounting_income_statement','openai_cost_reserve','openai_cost_finish','openai_cost_summary']);
let providerCalls = 0;
const safeFetch = (url, init = {}) => {
  const u = new URL(url), method = init.method || 'GET';
  if (u.origin === 'https://api.openai.com' && u.pathname === '/v1/responses' && method === 'POST') {
    assert.ok(++providerCalls <= (sol ? 2 : 1), 'Provider call ceiling reached.');
    const requested = JSON.parse(init.body).model;
    assert.equal(requested, providerCalls === 1 ? OPENAI_MODELS.default : OPENAI_MODELS.escalation);
  } else if (u.origin !== origin || (method !== 'GET' && !(method === 'POST' && u.pathname.startsWith('/rest/v1/rpc/') && allowedRpc.has(u.pathname.split('/').at(-1))))) {
    throw new Error('VALIDATION_WRITE_OR_DESTINATION_BLOCKED');
  }
  return fetch(url, init);
};
try {
  const started = Date.now(), signal = AbortSignal.timeout(60000);
  const store = new ModelCostStore(settings.rest, safeFetch);
  const budget = await store.summary(policy);
  assert.equal(budget.policy?.quota_blocked, false, 'API remains suspended. Resolve balance and explicitly rehabilitate it in Administration first.');
  const source = new CopilotSources(settings.rest, settings.actor, signal, safeFetch);
  const result = await new ToolRegistry(source).execute('get_sales_summary', { period: 'this_month' });
  const sales = result.data?.totals?.sales;
  assert.ok(['ok','partial'].includes(result.status) && typeof sales === 'number' && Number.isFinite(sales), 'Verified sales total unavailable. No model call performed.');
  const router = new ModelRouter(policy, { requestId: `${sol ? 'sol-validation' : 'luna-validation'}-${todayChile()}`, conversationId: null, userId: settings.actor.id, role: settings.actor.role, message: sol ? 'Usa Sol para validar este total' : 'Valida este total' }, store, env('OPENAI_API_KEY'), safeFetch);
  const body = { input: [{ role: 'user', content: `Devuelve exactamente el total de ventas de la fuente CRM: ${sales}. Resumen breve, sin agregar otras cifras. Estado de cobertura: ${result.status}.` }], max_output_tokens: 512, tools: [], tool_choice: 'none', reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', name: 'controlled_sales_validation', strict: true, schema: { type: 'object', properties: { source_total_sales: { type: 'number' }, summary: { type: 'string' } }, required: ['source_total_sales','summary'], additionalProperties: false } } } };
  let payload = await router.call(body, 'executive', signal);
  if (sol) payload = await router.escalate(body, 'executive', signal, 'Validacion explicita', [result], false) || payload;
  const answer = JSON.parse(payload.output.flatMap(r => r.content || []).filter(p => p.type === 'output_text').map(p => p.text).join(''));
  assert.equal(answer.source_total_sales, sales, 'Model total does not match CRM. No retry.');
  console.log(JSON.stringify({ result: 'PASS', sourceStatus: result.status, matchedCrm: true, usage: router.usage, providerCalls, latencyMs: Date.now() - started, stopped: true }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAILED', code: error.code || 'CONTROLLED_VALIDATION_FAILED', providerCalls, retry: false, stopped: true })); process.exitCode = 1;
}
