import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { LatestReadQueue } from "../src/modules/accounting/latestReadQueue.ts";

function compile(source, name, dependencies) {
  const tree = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(tree.statements
    .filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(tree).replace(/^export\s+/, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${code};return ${name};`)(...Object.values(dependencies));
}

const events = new Map();
const effects = [];
const states = [];
const reads = [];
let interval;
let cleanup;
const api = compile(await readFile("src/modules/accounting/useAccountingCenter.ts", "utf8"), "useAccountingCenter", {
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useState: value => {
    const state = { value };
    states.push(state);
    return [value, next => { state.value = next; }];
  },
  useEffect: fn => effects.push(fn),
  getAccountingBootstrap: async () => {
    const result = {
      profile: { permissions: ["import"] },
      factoFreshness: { stale: true, integrationUpdatedAt: "2026-09-26T13:00:00Z" },
      read: reads.length + 1,
    };
    reads.push(result);
    return result;
  },
  syncAccountingFacto: () => assert.fail("A read must never synchronize documents"),
  LatestReadQueue,
  window: {
    setInterval: fn => { interval = fn; return 1; },
    clearInterval: () => { interval = null; },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  },
  document: {
    visibilityState: "visible",
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  },
});
const hook = api();
for (const effect of effects) cleanup = effect();
const settle = () => new Promise(resolve => setImmediate(resolve));
await settle();
assert.equal(reads.length, 1);
for (const trigger of [() => interval(), () => events.get("focus")(), () => events.get("visibilitychange")(), () => hook.refresh()]) {
  const previous = reads.length;
  await trigger();
  await settle();
  assert.equal(reads.length, previous + 1);
  assert.equal(states[0].value, reads.at(-1));
}
cleanup();
assert.equal(events.size, 0);
assert.equal(interval, null);

const clientSource = await readFile("src/lib/accountingApi.ts", "utf8");
const clientTree = ts.createSourceFile("api.ts", clientSource, ts.ScriptTarget.Latest, true);
const syncNode = clientTree.statements.find(node => node.name?.text === "syncAccountingFacto");
const requests = [];
const syncClient = compile(syncNode.getText(clientTree), "syncAccountingFacto", {
  accountingRequest: (route, options) => requests.push({ route, options }),
});
const range = { fromDate: "2026-01-01", toDate: "2026-09-26" };
await syncClient(range);
assert.deepEqual(requests, [{ route: "facto/sync", options: { method: "POST", body: { ...range, triggerType: "manual" } } }]);

const edgeSource = await readFile("supabase/functions/accounting-center/index.ts", "utf8");
const edgeTree = ts.createSourceFile("edge.ts", edgeSource, ts.ScriptTarget.Latest, true);
const edgeNode = edgeTree.statements.find(node => node.name?.text === "syncFacto");
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
let selected = 0;
const syncServer = compile(edgeNode.getText(edgeTree), "syncFacto", {
  HttpError,
  selectRows: async () => { selected++; return []; },
});
for (const triggerType of [undefined, "automatic", "focus", ""]) {
  await assert.rejects(syncServer({}, {}, "request", { ...range, triggerType }), error => error.status === 409 && /Actualizar ahora/.test(error.message));
}
assert.equal(selected, 0, "Legacy automatic calls must stop before touching any table");
await assert.rejects(syncServer({}, {}, "request", { ...range, triggerType: "manual" }), /migraci/);
assert.equal(selected, 1, "Explicit sync still reaches the existing authenticated service");
console.log("Finance refresh is read-only; initial load, interval, focus, visibility, refresh and legacy-client guard passed.");
