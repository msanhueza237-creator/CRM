import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  await db.exec('create table integration_records(id int primary key, provider text, resource text, external_id text, payload jsonb, payload_hash text, observed_at timestamptz, updated_at timestamptz)');
  const sql = await readFile(new URL('../supabase/facto_preserve_product_details.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  const full = { product_id: '42', sku: 'ACB-C01', name: 'Soporte', inventories: { details: [{ product_location_id: '1', available_quantity: '468' }] }, price: [{ unit_net: '6490' }] };
  await db.query("insert into integration_records values(1,'facto','product_details','42',$1,'original','2026-09-08','2026-09-08')", [JSON.stringify(full)]);
  const original = (await db.query('select * from integration_records')).rows[0];
  const update = (payload) => db.query("update integration_records set payload=$1,payload_hash='new',observed_at='2026-09-09',updated_at='2026-09-09' where id=1", [JSON.stringify(payload)]);
  for (let i = 0; i < 2; i++) {
    await update({ product_id: '42', sku: 'acb-c01', name: 'Listado sin detalle' });
    assert.deepEqual((await db.query('select * from integration_records')).rows[0], original, 'Incomplete reread must not refresh the original observation date/hash');
  }
  const zero = { ...full, inventories: { details: [{ product_location_id: '1', available_quantity: '0' }] } };
  await update(zero);
  assert.deepEqual((await db.query('select payload from integration_records')).rows[0].payload, zero, 'A verified zero replaces old positive stock');
  const changedIdentity = { product_id: '42', sku: 'NEW-SKU', name: 'Nueva identidad' };
  await update(changedIdentity);
  assert.deepEqual((await db.query('select payload from integration_records')).rows[0].payload, changedIdentity, 'Never move an old quantity to another SKU');
  await db.query("update integration_records set resource='products',payload=$1 where id=1", [JSON.stringify(full)]);
  await update({ product_id: '42', sku: 'ACB-C01' });
  assert.deepEqual((await db.query('select payload from integration_records')).rows[0].payload, { product_id: '42', sku: 'ACB-C01' });
  console.log('PASS atomic detail retention, observation dates, repeat sync, explicit zero, identity change and resource isolation');
} finally { await db.close(); }
