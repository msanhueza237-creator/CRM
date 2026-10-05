import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { previewMarketImport } from '../supabase/functions/_shared/market-study-contract.ts';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function prepareResearch(raw, now = Date.now()) {
  if (Buffer.byteLength(raw, 'utf8') > 350000) throw new Error('Máximo 350 KB por lote.');
  const preview = previewMarketImport(JSON.parse(raw.replace(/^\uFEFF/, '')), now);
  if (!preview.canImport) return { valid: false, errors: preview.errors, total: preview.total };
  const payload = { schema_version: 1, observations: preview.items };
  const json = JSON.stringify(canonical(payload), null, 2) + '\n';
  if (Buffer.byteLength(json, 'utf8') > 350000) throw new Error('El JSON normalizado supera 350 KB; divide el lote.');
  return { valid: true, payload, json, sha256: createHash('sha256').update(json).digest('hex'), total: preview.total,
    warnings: preview.items.flatMap((item,index) => {
      const warnings = [];
      if (item.amount === null || item.currency === null || item.vat_basis === 'unknown') warnings.push('Precio, moneda o IVA incompletos.');
      if (item.currency && item.currency !== 'CLP' && !item.fx) warnings.push('Falta cambio fechado a CLP.');
      if (now - Date.parse(item.observed_at) > 30 * 86400000) warnings.push('Investigación de más de 30 días.');
      if (item.fx && now - Date.parse(item.fx.observed_at) > 7 * 86400000) warnings.push('Cambio de más de 7 días.');
      if (item.confidence < .7 || item.availability !== 'available') warnings.push('Confianza o disponibilidad insuficiente para ranking.');
      return warnings.map(message => ({ row: index + 1, message }));
    }) };
}
async function main(args) {
  if (!args.length || args.includes('--help')) {
    console.log('Uso: node --experimental-strip-types scripts/prepare-market-research.mjs entrada.json [--out salida.json]\nValida sin red ni credenciales. --out escribe un archivo nuevo, nunca sobrescribe. No importa ni aprueba equivalencias.');
    return;
  }
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--out')) throw new Error('Argumentos inválidos; usa --help.');
  const info = await stat(args[0]);
  if (!info.isFile() || info.size > 350000) throw new Error('Se requiere un archivo JSON de hasta 350 KB.');
  const prepared = prepareResearch(await readFile(args[0], 'utf8'));
  if (!prepared.valid) { console.error(JSON.stringify(prepared, null, 2)); process.exitCode = 2; return; }
  if (args[2]) await writeFile(args[2], prepared.json, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ valid: true, total: prepared.total, sha256: prepared.sha256, output: args[2] ? resolve(args[2]) : null, warnings: prepared.warnings, imported: false, equivalencesApproved: false }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
