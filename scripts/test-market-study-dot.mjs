import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareResearch } from './prepare-market-research.mjs';
const now=Date.parse('2026-10-03T12:00:00Z');
const offer={provider:'research-fixture',external_id:'offer-1',revision:1,product_label:'Synthetic pump',suggested_sku:null,seller:'Synthetic seller',seller_kind:'competitor',amount:119,currency:'CLP',vat_basis:'gross',vat_percent:19,unit:'unit',package_quantity:1,presentation:'one unit',availability:'available',source_url:'https://example.test/pump',observed_at:'2026-10-01T12:00:00Z',confidence:.9,fx:null,notes:'Synthetic fixture; never production'};
const raw=JSON.stringify({schema_version:1,observations:[offer]});
test('Paquete sin red: normaliza, mantiene identidad y checksum estable ante orden de campos',()=>{
 const p=prepareResearch(raw,now);assert.equal(p.valid,true);assert.equal(p.total,1);assert.deepEqual(p.warnings,[]);
 const reversed=Object.fromEntries(Object.entries(offer).reverse());assert.equal(prepareResearch(JSON.stringify({observations:[reversed],schema_version:1}),now).sha256,p.sha256);
 assert.equal(prepareResearch(p.json,now).sha256,p.sha256);assert.equal(p.payload.observations[0].external_id,'offer-1');
});
test('Paquete rechaza payload inválido y duplicados; ausencias y obsolescencia permanecen visibles',()=>{
 assert.equal(prepareResearch(JSON.stringify({schema_version:1,observations:[offer,offer]}),now).valid,false);
 assert.equal(prepareResearch(JSON.stringify({schema_version:1,observations:[{...offer,approved:true}]}),now).valid,false);
 assert.throws(()=>prepareResearch(' '.repeat(350001),now),/350 KB/);
 const p=prepareResearch(JSON.stringify({schema_version:1,observations:[{...offer,amount:null,vat_basis:'unknown',vat_percent:null,observed_at:'2020-01-01T00:00:00Z'}]}),now);
 assert.equal(p.valid,true);assert.equal(p.payload.observations[0].amount,null);assert.equal(p.warnings.length,2);
});
test('CLI produce archivo importable; no sobrescribe ni escribe cuando el lote es inválido',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'market-dot-')),input=join(dir,'input.json'),output=join(dir,'output.json');await writeFile(input,raw);
 const run=(out)=>spawnSync(process.execPath,['--experimental-strip-types','scripts/prepare-market-research.mjs',input,'--out',out],{encoding:'utf8'});
 let r=run(output);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).imported,false);const before=await readFile(output,'utf8');assert.equal(JSON.parse(before).observations.length,1);
 r=run(output);assert.equal(r.status,1);assert.equal(await readFile(output,'utf8'),before);
 await writeFile(input,JSON.stringify({schema_version:1,observations:[{...offer,amount:'119'}]}));const invalid=join(dir,'invalid.json');assert.equal(run(invalid).status,2);await assert.rejects(access(invalid));
});
