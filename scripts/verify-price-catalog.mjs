// Read-only audit against the existing VPS. Artifacts stay in ignored tmp/.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolveProducts } from '../supabase/functions/crm-copilot/product-resolution.ts';
import { productPrices, clientPriceRows, factoCurrencies } from '../supabase/functions/crm-copilot/product-prices.ts';

const sshArgs = ['-o', 'BatchMode=yes', '-i', `${process.env.USERPROFILE}/.ssh/climactiva_vps`, 'root@187.77.53.52'];
const sql = `select json_build_object(
  'records',(select json_agg(r) from (select external_id,resource,updated_at,payload - 'cost' as payload from integration_records where provider='facto' and resource in ('product_details','inventory_snapshots')) r),
  'catalog',(select json_agg(c) from (select id,sku,name,brand,description_text,product_url,last_synced_at,source_status,stock,has_stock,variants from content_products) c)
);`;
const previous = process.argv.includes('--retry') ? JSON.parse(await readFile(new URL('../tmp/price-catalog/read-only-audit.json', import.meta.url), 'utf8')) : null;
const saved = previous ? { records: [...previous.records, ...previous.snapshots], catalog: previous.catalog } : JSON.parse(execFileSync('ssh', [...sshArgs, 'docker exec -i crm-climactiva-supabase-duewf7-supabase-db psql -X -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 20_000_000 }));
const details = saved.records.filter((r) => r.resource === 'product_details');
const snapshots = saved.records.filter((r) => r.resource === 'inventory_snapshots');
const stats = (products) => ({ identified: products.length, available: products.filter((p) => p.stock > 0).length, unavailable: products.filter((p) => p.stock !== null && p.stock <= 0).length, unknown: products.filter((p) => p.stock === null).length, tiendanube: products.filter((p) => p.stock_source === 'tiendanube_catalog').length });
console.log('Saved CRM with corrected reader:', stats(resolveProducts(snapshots, details, saved.catalog, false)));
const ids = (previous ? previous.failures.map((r) => r.id) : details.map((r) => r.external_id)).filter((id) => /^\d+$/.test(id));
const script = await readFile(new URL('./read-facto-product-stock.py', import.meta.url), 'utf8');
const live = JSON.parse(execFileSync('ssh', [...sshArgs, `docker exec -i crm-climactiva-agente-inteligente-comercial-amxo4p-hub-worker-1 python - '${JSON.stringify(ids)}'`], { input: script, encoding: 'utf8', maxBuffer: 20_000_000, stdio: ['pipe', 'pipe', 'inherit'] }));
const observedAt = new Date().toISOString();
const enriched = details.map((record) => {
  const found = live.records.find((p) => p.external_id === record.external_id);
  return found ? { ...record, ...found, updated_at: observedAt } : record;
});
const verified = resolveProducts(snapshots, enriched, saved.catalog, false);
console.log('Live Facto read + catalog fallback:', stats(verified), 'Failed reads:', live.failures.length);
const prices = productPrices(snapshots, enriched, saved.catalog, { scope: 'catalog' }, factoCurrencies());
const exportRows = clientPriceRows(prices.records, true);
console.log('Exportable rows:', exportRows.length, 'Pending net prices:', exportRows.filter((r) => r.net === null).length);
await mkdir(new URL('../tmp/price-catalog/', import.meta.url), { recursive: true });
await writeFile(new URL('../tmp/price-catalog/read-only-audit.json', import.meta.url), JSON.stringify({ observedAt, before: stats(resolveProducts(snapshots, details, saved.catalog, false)), after: stats(verified), failures: live.failures, records: enriched, catalog: saved.catalog, snapshots, exportRows }));
console.log('Read-only audit complete. No CRM or Facto records modified.');
