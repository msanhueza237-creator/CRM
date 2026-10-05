import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Local fixture regression only: does not run GoTrue, Docker, SSH or the Python harness.
const source = await readFile(new URL('./market-research-e2e/run.py', import.meta.url), 'utf8');
const authLine = source.split('\n').find(line => line.includes("create('auth',"));
const userLine = source.split('\n').find(line => line.includes("http('/auth/v1/admin/users','POST'"));
const field = (line, name) => line?.match(new RegExp(`'${name}':'([^']*)'`))?.[1];
const defaultRole = field(authLine, 'GOTRUE_JWT_DEFAULT_GROUP_NAME');
const requestedRole = field(userLine, 'role');
assert.equal(defaultRole, 'authenticated');
assert.equal(requestedRole, defaultRole);
assert.ok(source.includes("assert claims.get('role')=='authenticated'"));
assert.ok(source.indexOf("assert claims.get('role')=='authenticated'") < source.indexOf("status,catalog=http("));

const db = new PGlite();
const evidence = {
  checked_at: new Date().toISOString(),
  scope: 'Local fixture configuration and actual PGlite SQL role selection; no GoTrue/JWT issuance or Python execution',
  config: { defaultRole, requestedRole, earlyClaimAssertion: true },
  checks: [],
};
try {
  await db.exec('create role authenticator noinherit; create role authenticated nologin; grant authenticated to authenticator; create table private_fixture(id integer); revoke all on private_fixture from public,authenticated;');
  for (const role of ['', 'nonexistent_fixture_role', requestedRole]) {
    await db.exec('begin; set session authorization authenticator;');
    try {
      const result = await db.query("select set_config('role', $1, true) as selected_role", [role]);
      assert.equal(role, 'authenticated', 'Missing/unknown role must fail closed');
      assert.equal(result.rows[0].selected_role, requestedRole);
      await assert.rejects(db.query('select * from private_fixture'), error => error.code === '42501');
      evidence.checks.push({ name: 'Explicit authenticated role resolves without granting private-table access', passed: true });
    } catch (error) {
      if (role === 'authenticated') throw error;
      assert.equal(error.code, '22023');
      assert.match(error.message, /does not exist/);
      evidence.checks.push({ name: role === '' ? 'Empty role reproduces observed database failure' : 'Unknown role rejected', passed: true, sqlstate: error.code });
    } finally {
      await db.exec('rollback; reset session authorization;');
    }
  }
  evidence.runtimeConfirmationPending = 'Real GoTrue-issued token and full HTTP E2E must still be rerun in an authorized suitable window.';
  await writeFile(new URL('../outputs/market-research-e2e/local-role-validation.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS fixture role configuration, early claim guard, empty/unknown role failures and least-privilege SQL role (local PGlite only).');
} finally {
  await db.close();
}
