import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Explicit disposable local cluster only. Does not start/stop servers or use env credentials.
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = option('repo'), bin = option('pg-bin'), data = option('data'), output = option('output');
if (![repo, bin, data, output].every(Boolean)) throw Error('Required: --repo= --pg-bin= --data= --output= (disposable local cluster only)');
const port = Number(option('port') || 65439);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const normalized = p => path.resolve(p).replaceAll('\\', '/').toLowerCase();
assert.match(normalized(data), /\/postgres-local-17\/data$/);
const psql = path.join(bin, 'psql.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));
Object.assign(env, { PGPASSFILE: path.join(output, 'absent-password-file'), PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', PGSSLMODE: 'disable' });
fs.mkdirSync(output, { recursive: true });
const args = db => ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'crm_test_owner', '-d', db, '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
function command(db, extra) {
  const result = spawnSync(psql, [...args(db), ...extra], { env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2e6 });
  if (result.status !== 0) throw Error(`Fixture psql failed: ${(result.stderr || result.error?.message || '').slice(-1500)}`);
  return result.stdout.trim();
}
const server = JSON.parse(command('postgres', ['-c', "select json_build_object('data',current_setting('data_directory'),'address',inet_server_addr(),'port',inet_server_port(),'user',current_user,'version',version(),'sharedBuffers',current_setting('shared_buffers'),'maxConnections',current_setting('max_connections'));"]));
assert.equal(normalized(server.data), normalized(data));
assert.equal(server.address, '127.0.0.1'); assert.equal(server.port, port); assert.equal(server.user, 'crm_test_owner');
const database = 'crm_facto_test_' + crypto.randomBytes(5).toString('hex');
command('postgres', ['-c', `CREATE DATABASE ${database};`]);
const actor = '00000000-0000-4000-8000-000000000001';
const sqlFiles = ['accounting_center.sql', 'accounting_facto_history.sql', 'accounting_facto_sync_safety.sql'];
const sources = sqlFiles.map(file => fs.readFileSync(path.join(repo, 'supabase', file), 'utf8'));
const hashes = Object.fromEntries(sqlFiles.map((file, i) => [file, crypto.createHash('sha256').update(sources[i]).digest('hex')]));
const setup = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
end $$;
create schema auth; create schema storage;
create type public.app_role as enum ('administrador','vendedor','visualizador');
create table auth.users(id uuid primary key);
insert into auth.users values ('${actor}');
create table public.profiles(id uuid primary key,full_name text default '',role public.app_role default 'visualizador',active boolean default true);
insert into public.profiles values ('${actor}','Synthetic','administrador',true);
create function auth.uid() returns uuid language sql stable as $$ select '${actor}'::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.role',true),''),'service_role') $$;
create function public.current_role() returns public.app_role language sql stable as $$ select 'administrador'::public.app_role $$;
create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
create table public.accounting_snapshots(id uuid primary key default gen_random_uuid());
` + sources[0].replace(/create extension if not exists pgcrypto;/i, '-- gen_random_uuid is built in; no optional extension needed in this fixture.') + '\n' + sources[1] + '\n' + sources[2];
const setupFile = path.join(output, `${database}-setup.sql`);
fs.writeFileSync(setupFile, setup);
command(database, ['-f', setupFile]);

class Connection {
  constructor(label) {
    this.label = label; this.buffer = ''; this.rows = []; this.sequence = 0; this.pending = null;
    this.child = spawn(psql, [...args(database), '-v', 'ON_ERROR_STOP=0'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', chunk => { this.lastError = chunk.toString('utf8').trim(); });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      while (this.buffer.includes('\n')) {
        const position = this.buffer.indexOf('\n'), line = this.buffer.slice(0, position).replace(/\r$/, '');
        this.buffer = this.buffer.slice(position + 1);
        if (this.pending && line.startsWith(this.pending.marker + ' ')) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
          pending.resolve({ state: line.slice(pending.marker.length + 1).trim(), rows: this.rows.filter(Boolean), error: this.lastError });
          this.rows = []; this.lastError = '';
        } else this.rows.push(line);
      }
    });
    this.child.on('error', error => this.pending?.reject(error));
    this.exited = new Promise(resolve => this.child.on('exit', code => {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(Error(`${label} exited (${code})`)); this.pending = null; }
      resolve(code);
    }));
  }
  query(sql) {
    assert.equal(this.pending, null, `${this.label}: only one active query per connection`);
    return new Promise((resolve, reject) => {
      const marker = `__CRM_DONE_${this.label}_${++this.sequence}__`;
      const timer = setTimeout(() => { this.child.kill(); reject(Error(`${this.label}: query exceeded 20 seconds`)); }, 20000);
      this.pending = { marker, resolve, reject, timer };
      this.child.stdin.write(`${sql}\n\\echo ${marker} :SQLSTATE\n`);
    });
  }
  async ok(sql) { const r = await this.query(sql); assert.equal(r.state, '00000', r.error); return r.rows; }
  async json(sql) { return JSON.parse((await this.ok(sql)).at(-1)); }
  async close(abrupt = false) {
    if (this.child.exitCode !== null) return;
    if (abrupt) this.child.kill(); else this.child.stdin.end('\\q\n');
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exited; clearTimeout(timer);
  }
}
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
let a = new Connection('A'), b = new Connection('B');
const report = { database, server, sqlSha256: hashes, startedAt: new Date().toISOString(), cases: [] };
const pass = (name, details = {}) => { report.cases.push({ name, passed: true, ...details }); console.log('PASS ' + name); };
try {
  for (const c of [a, b]) await c.ok("set statement_timeout='10s';");
  const pidA = Number((await a.ok('select pg_backend_pid();'))[0]), pidB = Number((await b.ok('select pg_backend_pid();'))[0]);
  assert.notEqual(pidA, pidB); report.backendPids = [pidA, pidB];
  const entity = (await a.ok('select id from accounting_entities order by created_at limit 1;'))[0];
  const claimSql = () => `select accounting_claim_facto_sync(${quote(entity)},'2026-01-01','2026-01-31',${quote(actor)},'real-pg-synthetic');`;
  const headers = (c, lease) => c.ok(`select set_config('request.headers',${quote(lease ? JSON.stringify({'x-facto-sync-run': lease.runId, 'x-facto-sync-token': lease.token}) : '{}')},false);`);
  const finish = (c, lease, status = 'completed') => c.ok(`select accounting_finish_facto_sync(${quote(lease.runId)},${quote(lease.token)},${quote(status)});`);
  const blockedByA = async () => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const blockers = await a.json(`select to_json(pg_blocking_pids(${pidB}));`);
      if (blockers.includes(pidA)) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  };

  await a.ok('begin;');
  const first = await a.json(claimSql()); assert.equal(first.acquired, true);
  const secondPending = b.json(claimSql());
  assert.equal(await blockedByA(), true, 'second claim must actually wait on first transaction');
  await a.ok('commit;');
  const second = await secondPending;
  assert.equal(second.acquired, false); assert.equal(second.runId, first.runId);
  assert.equal(Number((await a.ok("select count(*) from accounting_facto_sync_runs where status='running';"))[0]), 1);
  pass('Two distinct PostgreSQL sessions: second claim waits, then returns active; one running execution', { pidA, pidB });

  const source = (await a.ok(`insert into accounting_source_documents(entity_id,source_type,source_key,document_type,status,total_clp,source_updated_at)
    values(${quote(entity)},'FACTO','facto:sale:real-pg','sales_invoice','validated',100,'2026-01-01') returning id;`))[0];
  await headers(a, first); await a.ok('begin;');
  await a.ok(`update accounting_source_documents set total_clp=101 where id=${quote(source)};`);
  const heartbeatPending = b.ok(`select accounting_heartbeat_facto_sync(${quote(first.runId)},${quote(first.token)});`);
  assert.equal(await blockedByA(), true);
  await a.ok('commit;'); await heartbeatPending;
  assert.equal((await b.ok(`select lease_expires_at > clock_timestamp()+interval '2 minutes' from accounting_facto_sync_runs where id=${quote(first.runId)};`))[0], 't');
  pass('Heartbeat waits for active write and renews after commit without deadlock');

  await a.ok('begin;'); await a.ok(`update accounting_source_documents set total_clp=102 where id=${quote(source)};`);
  const claimDuringWrite = b.json(claimSql());
  assert.equal(await blockedByA(), true);
  await a.ok(`insert into accounting_source_documents(entity_id,source_type,source_key,document_type,status,total_clp)
    values(${quote(entity)},'FACTO','facto:sale:fk-test','sales_invoice','validated',50);`);
  await a.ok('commit;'); assert.equal((await claimDuringWrite).acquired, false);
  pass('Concurrent claim and source foreign-key insert do not deadlock');

  // Lose a real connection mid-transaction, not merely a rejected promise.
  await a.ok('begin;'); await a.ok(`update accounting_source_documents set total_clp=999 where id=${quote(source)};`);
  await a.close(true);
  assert.equal(Number((await b.ok(`select total_clp from accounting_source_documents where id=${quote(source)};`))[0]), 102);
  // Move only the synthetic lease clock forward, avoiding a three-minute wait.
  await b.ok(`update accounting_facto_sync_leases set expires_at=clock_timestamp()-interval '1 second' where run_id=${quote(first.runId)};`);
  const replacement = await b.json(claimSql()); assert.equal(replacement.acquired, true); assert.notEqual(replacement.runId, first.runId);
  assert.equal((await b.ok(`select status from accounting_facto_sync_runs where id=${quote(first.runId)};`))[0], 'failed');
  pass('Lost connection rolls back uncommitted write; expired execution closes and can be replaced');

  a = new Connection('A_restarted'); await a.ok("set statement_timeout='10s';"); await headers(a, first);
  const stale = await a.query(`update accounting_source_documents set total_clp=999 where id=${quote(source)};`);
  assert.equal(stale.state, 'P0001');
  await headers(a, null);
  const staleFinish = await a.query(`select accounting_finish_facto_sync(${quote(first.runId)},${quote(first.token)},'completed');`);
  assert.equal(staleFinish.state, 'P0001');
  await headers(b, replacement); await b.ok(`update accounting_source_documents set total_clp=103 where id=${quote(source)};`);
  assert.equal(Number((await b.ok(`select total_clp from accounting_source_documents where id=${quote(source)};`))[0]), 103);
  pass('Replaced worker cannot write or finish; current worker retains write access');

  await a.ok(`update accounting_source_documents set status='posted' where id=${quote(source)};`);
  await b.ok(`update accounting_source_documents set status='validated',total_clp=999 where id=${quote(source)};`);
  const protectedRow = await b.json(`select json_build_object('status',status,'total',total_clp) from accounting_source_documents where id=${quote(source)};`);
  assert.equal(protectedRow.status, 'posted'); assert.equal(Number(protectedRow.total), 103);
  await headers(b, null); await finish(b, replacement);
  const next = await a.json(claimSql()); assert.equal(next.acquired, true); await finish(a, next, 'cancelled');
  assert.equal(Number((await a.ok("select count(*) from accounting_facto_sync_runs where status='running';"))[0]), 0);
  pass('Concurrent posting is preserved; terminal completion and cancellation release the lease');
  report.databaseBytes = Number((await a.ok('select pg_database_size(current_database());'))[0]);
  report.finishedAt = new Date().toISOString(); report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; throw error;
} finally {
  await Promise.allSettled([a.close(), b.close()]);
  fs.writeFileSync(path.join(output, 'concurrency-results.json'), JSON.stringify(report, null, 2));
  console.log(`Synthetic database retained: ${database}; result file: ${path.join(output, 'concurrency-results.json')}`);
}
