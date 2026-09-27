import { ModelRouter } from '../../supabase/functions/crm-copilot/model-router.ts';
import { modelPolicy } from '../../supabase/functions/_shared/openai-cost-policy.ts';
export function offlineRouter(options = {}, env = {}) {
  if (typeof options.fetcher !== 'function') throw new Error('Tests require an explicit mock fetcher. Live OpenAI is forbidden.');
  const reservations = [], completions = [];
  const store = { reserve: async row => { reservations.push(row); return { allowed: true }; }, finish: async row => { completions.push(row); } };
  const router = new ModelRouter(modelPolicy(k => ({ DAILY_OPENAI_BUDGET_USD: '100', OPENAI_ROUTER_MAX_OUTPUT_TOKENS: '512', OPENAI_RESPONSE_CACHE_TTL_SECONDS: '0', ...env })[k]),
    { requestId: crypto.randomUUID(), conversationId: 'fixture', userId: 'fixture', role: 'administrador', message: options.message || '' }, store, 'offline-test-key', options.fetcher);
  return Object.assign(router, { reservations, completions });
}
export function mockCostRpc(url, payload) {
  if (url.pathname.endsWith('/openai_cost_reserve')) return Response.json({ allowed: true });
  if (url.pathname.endsWith('/openai_cost_finish')) return Response.json({ ok: true });
  return null;
}
