import { executeExtraction, extractionPolicy, validateExtraction, ExtractionError, type ExtractionEnv } from './extraction.ts';
import { previewMarketImport, type MarketObservation } from '../_shared/market-study-contract.ts';

export const RESEARCH_SCOPES = { catalog: 'market-research:catalog:read', ingest: 'market-research:observations:write', extract: 'market-research:extract' } as const;
export interface ResearchEnv { url: string; serviceRoleKey: string; readEnv?: ExtractionEnv }
interface Binding { id: string; provider: string; allowed_skus: string[] }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
async function readBody(req: Request, maxBytes = 350000): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Use application/json.');
  const reader = req.body?.getReader(); if (!reader) throw new HttpError(400, 'JSON required.');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, `Maximum ${maxBytes} bytes.`); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function validateBatch(body: unknown, binding: Binding) {
  const obj = record(body);
  if (Object.keys(obj).some(k => !['schema_version', 'observations'].includes(k))) throw new HttpError(400, 'Unknown envelope field.');
  let preview: ReturnType<typeof previewMarketImport>;
  try { preview = previewMarketImport(body); } catch { throw new HttpError(400, 'Expected schema_version 1 and 1–200 observations.'); }
  // FX also has an exact field set: never silently accept instructions or privileges.
  if (Array.isArray(obj.observations)) obj.observations.forEach((raw, index) => {
    const fx = record(record(raw).fx);
    if (Object.keys(fx).some(k => !['currency', 'clp_per_unit', 'observed_at', 'source'].includes(k))) preview.errors.push({ row: index + 1, message: 'Unknown FX field.' });
  });
  if (preview.errors.length) return { ...preview, items: [], canImport: false };
  if (preview.items.some(p => p.provider !== binding.provider || !p.suggested_sku || !binding.allowed_skus.includes(p.suggested_sku))) throw new HttpError(403, 'Provider or SKU is outside the authorized scope.');
  return preview;
}
const publicUrl = (value: unknown) => {
  try { const url = new URL(String(value)); if (url.protocol !== 'https:' || url.username || url.password || url.port || !['climactiva.cl', 'www.climactiva.cl'].includes(url.hostname) || !url.pathname.startsWith('/productos/')) return null; url.search = ''; url.hash = ''; return url.toString(); } catch { return null; }
};
export function createResearchHandler(env: ResearchEnv, fetcher: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    try {
      const path = new URL(req.url).pathname;
      const route = path.match(/\/market-research\/(catalog|extraction-policy|extract|observations(?:\/preview)?)$/)?.[1];
      if (!route) throw new HttpError(404, 'Route not available.');
      const method = ['catalog','extraction-policy'].includes(route) ? 'GET' : 'POST';
      if (req.method !== method) throw new HttpError(405, 'Method not allowed.');
      if (new URL(req.url).search) throw new HttpError(400, 'Query parameters are not supported.');
      const secret = req.headers.get('x-climactiva-api-key')?.trim();
      if (!secret || secret.length > 512) throw new HttpError(401, 'Integration authentication required.');
      if (!env.url || !env.serviceRoleKey) throw new HttpError(503, 'Research API unavailable.');
      const rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        let response: Response;
        try { response = await fetcher(`${env.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: route === 'extract' ? AbortSignal.timeout(15000) : AbortSignal.any([req.signal, AbortSignal.timeout(15000)]) }); }
        catch { throw new HttpError(503, 'Research API unavailable; retry the same batch.'); }
        let body: unknown; try { body = await response.json(); } catch { throw new HttpError(503, 'Invalid upstream response.'); }
        if (!response.ok) {
          const code = record(body).code;
          if (code === '42501') throw new HttpError(403, 'Integration is not authorized.');
          if (code === '23505' || code === '40001') throw new HttpError(409, 'Identity conflict or nonconsecutive revision; retry only an unchanged batch.');
          if (code === 'P0002') throw new HttpError(429, 'Quota, budget or concurrency limit reached; retry later with the same identities.');
          if (code === '22023') throw new HttpError(422, 'Invalid research batch.');
          throw new HttpError(503, 'Research API unavailable; retry the same batch.');
        }
        return body;
      };
      const scope = route === 'catalog' ? RESEARCH_SCOPES.catalog : ['extract','extraction-policy'].includes(route) ? RESEARCH_SCOPES.extract : RESEARCH_SCOPES.ingest;
      const authResult = await rpc('validate_agent_api_key', { p_api_key: secret, p_required_scope: scope });
      const auth = record(Array.isArray(authResult) ? authResult[0] : null);
      if (auth.valid !== true || !uuid(auth.key_id) || !Array.isArray(auth.scopes) || !auth.scopes.includes(scope)) throw new HttpError(401, 'Invalid, expired, revoked or insufficiently scoped integration credential.');
      const rawBinding = record(await rpc('market_research_access', { p_key_id: auth.key_id, p_scope: scope }));
      if (!uuid(rawBinding.id) || typeof rawBinding.provider !== 'string' || !Array.isArray(rawBinding.allowed_skus) || !rawBinding.allowed_skus.every(s => typeof s === 'string')) throw new HttpError(503, 'Invalid integration configuration.');
      const binding = rawBinding as unknown as Binding;
      const extractionContext = { ...env, readEnv: env.readEnv || (() => undefined), fetcher };
      if (route === 'extraction-policy') return json(await extractionPolicy(extractionContext));
      if (route === 'extract') {
        const input = validateExtraction(await readBody(req, 28000));
        if (input.provider !== binding.provider || !binding.allowed_skus.includes(input.sku)) throw new HttpError(403, 'Provider or SKU is outside the authorized scope.');
        const result = await executeExtraction(input, String(auth.key_id), extractionContext, rpc);
        return json(result, result.state === 'running' ? 202 : 200);
      }
      if (route === 'catalog') {
        const result = record(await rpc('market_research_catalog', { p_key_id: auth.key_id }));
        if (!Array.isArray(result.items) || typeof result.unavailable_skus !== 'number') throw new HttpError(503, 'Invalid catalog response.');
        const items = result.items.map(raw => {
          const row = record(raw);
          if (typeof row.sku !== 'string' || !binding.allowed_skus.includes(row.sku) || typeof row.name !== 'string') throw new HttpError(503, 'Invalid catalog scope.');
          // Explicit output allowlist; no forwarding arbitrary database columns or variants.
          return { sku: row.sku, name: row.name, brand: typeof row.brand === 'string' ? row.brand : null, product_url: publicUrl(row.product_url), catalog_observed_at: typeof row.catalog_observed_at === 'string' ? row.catalog_observed_at : null };
        });
        return json({ schema_version: 1, provider: binding.provider, catalog_scope: 'authorized_published_catalog', items, unavailable_skus: result.unavailable_skus, fetched_at: new Date().toISOString() });
      }
      const preview = validateBatch(await readBody(req), binding);
      if (!preview.canImport) return json({ schema_version: 1, canImport: false, errors: preview.errors, total: preview.total }, 422);
      if (route === 'observations/preview') return json({ schema_version: 1, ...preview, equivalence_approved_by_api: false });
      const result = record(await rpc('market_research_ingest', { p_key_id: auth.key_id, p_items: preview.items as MarketObservation[] }));
      if (!Number.isInteger(result.inserted) || !Number.isInteger(result.duplicates) || !Array.isArray(result.receipts)) throw new HttpError(503, 'Receipt unavailable; retry the same batch.');
      const receipts = result.receipts.map(raw => {
        const row = record(raw);
        if (!uuid(row.observation_id) || typeof row.external_id !== 'string' || !Number.isInteger(row.revision) || !['inserted', 'duplicate'].includes(String(row.disposition))) throw new HttpError(503, 'Receipt unavailable; retry the same batch.');
        return { observation_id: row.observation_id, external_id: row.external_id, revision: row.revision, disposition: row.disposition };
      });
      return json({ schema_version: 1, provider: binding.provider, inserted: result.inserted, duplicates: result.duplicates, receipts, equivalence_approved_by_api: false });
    } catch (error) { if (error instanceof ExtractionError) return json({ error: error.code }, error.status); return json({ error: error instanceof HttpError ? error.message : 'Research API unavailable.' }, error instanceof HttpError ? error.status : 503); }
  };
}
