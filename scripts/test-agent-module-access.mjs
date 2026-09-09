import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { buildAccountingAgentReport, hasAccountingTaskLease } from '../supabase/functions/accounting-center/agent-report.ts';

const source = await readFile('supabase/functions/accounting-center/index.ts', 'utf8');
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const names = ['accountingAgentReport', 'requirePermission'];
const pieces = tree.statements.filter((node) => names.includes(node.name?.text)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(tree) === 'rolePermissions')));
const code = ts.transpileModule(pieces.map((node) => node.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const task = { id: '00000000-0000-0000-0000-000000000001', requested_by: 'user', agent_type: 'finance', action: 'review_margin', status: 'in_progress', worker_id: 'worker', lease_token: 'lease', lease_expires_at: new Date(Date.now() + 60000).toISOString() };
const rest = { serviceRoleKey: 'test-only-key' };
let currentTask = task;
let profile = { id: 'user', active: true, role: 'finanzas' };
let reads = 0;
let queries = 0;
const dependencies = {
  HttpError, buildAccountingAgentReport, hasAccountingTaskLease,
  readJson: (request) => request.json(),
  selectRows: async () => { queries++; return [currentTask]; },
  getProfile: async (_rest, id) => { assert.equal(id, task.requested_by); return profile; },
  bootstrap: async (_rest, _profile, summaryOnly, forAgent) => { reads++; assert.equal(summaryOnly, true); assert.equal(forAgent, true); return {}; },
};
const handler = new Function(...Object.keys(dependencies), `${code};return accountingAgentReport;`)(...Object.values(dependencies));
const request = (key = rest.serviceRoleKey) => new Request('http://local/internal/agent-report', {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ task_id: task.id, worker_id: 'worker', lease_token: 'lease', requested_by: 'forged-admin' }),
});
await assert.rejects(handler(request('user-jwt'), rest), (error) => error.status === 403);
assert.equal(queries, 0);
await handler(request(), rest);
assert.equal(reads, 1);
for (const denied of [{ id: 'user', role: 'vendedor', active: true }, { id: 'user', role: 'administrador', active: false }, null]) {
  profile = denied;
  await assert.rejects(handler(request(), rest), (error) => error.status === 403);
}
assert.equal(reads, 1);
currentTask = { ...task, requested_by: null };
await handler(request(), rest);
assert.equal(reads, 2);
currentTask = { ...task, lease_token: 'another-lease' };
await assert.rejects(handler(request(), rest), (error) => error.status === 409);
assert.equal(reads, 2);
console.log('Acceso a informes: clave interna, identidad almacenada, roles, usuario inactivo y lease verificados.');
