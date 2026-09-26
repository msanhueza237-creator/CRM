import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const windows = process.platform === 'win32'
const bash = windows ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const unixPath = (value) => windows
  ? execFileSync('C:/Program Files/Git/usr/bin/cygpath.exe', ['-u', value], { encoding: 'utf8' }).trim()
  : value
const source = (await readFile(new URL('./backup-database.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
const oldNames = ['20000101', '20000102', '20000103'].map((date) => `climactiva-crm-${date}-030001.dump`)

const docker = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_ROOT/calls"
for arg in "$@"; do
 case "$arg" in
 pg_dump)
   touch "$MOCK_ROOT/started"
   case "$MOCK_MODE" in fail) exit 1;; empty) exit 0;; corrupt) printf BROKEN; exit 0;; esac
   printf VALID-NEW
   if [[ "$MOCK_MODE" = guard ]]; then exec sleep 30; fi
   exit 0;;
 pg_restore)
   data="$(cat)"
   [[ "$data" = VALID-* ]] || exit 1
   if [[ "$MOCK_MODE" = concurrent && "$data" = VALID-OLD-2 ]]; then printf CHANGED > "$BACKUP_DIR/climactiva-crm-20000102-030001.dump"; fi
   exit 0;;
 psql) exit 0;;
 esac
done
exit 9
`
const df = `#!/usr/bin/env bash
printf 'Avail\\n'
if [[ "$MOCK_MODE" = guard && -f "$MOCK_ROOT/started" ]]; then printf '100\\n'; else printf '%s\\n' "$MOCK_FREE"; fi
`
const flock = `#!/usr/bin/env bash
[[ "$1" = -n && "$2" = 9 ]] || exit 2
[[ "$MOCK_LOCKED" != true ]]
`

async function scenario(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'crm-backup-test-'))
  const backups = path.join(root, 'backups')
  const bin = path.join(root, 'bin')
  await mkdir(backups)
  await mkdir(bin)
  await writeFile(path.join(root, 'backup-database.sh'), source)
  for (const [name, content] of Object.entries({ docker, df, flock })) {
    await writeFile(path.join(bin, name), content, { mode: 0o755 })
  }
  for (const [index, name] of oldNames.entries()) {
    await writeFile(path.join(backups, name), options.badKeeper && index === 2 ? 'BROKEN-OLD' : `VALID-OLD-${index}`)
  }
  await writeFile(path.join(backups, 'unrelated.dump'), 'KEEP')
  await writeFile(path.join(backups, 'climactiva-crm-20000101-030001.dump.partial'), 'KEEP-PARTIAL')
  if (options.future) await writeFile(path.join(backups, 'climactiva-crm-20991231-030001.dump'), 'VALID-FUTURE')
  const before = await readdir(backups)
  try {
    let result
    try {
      result = await run(bash, ['--noprofile', '--norc', '-c', 'export PATH="$MOCK_BIN:/usr/bin:/bin"; exec bash "$SCRIPT_FILE" "$MODE_ARG"'], {
        cwd: root, timeout: 30000, encoding: 'utf8',
        env: { ...process.env,
          MOCK_ROOT: unixPath(root), MOCK_BIN: unixPath(bin), SCRIPT_FILE: unixPath(path.join(root, 'backup-database.sh')),
          MODE_ARG: options.plan ? '--plan' : '--run', BACKUP_DIR: unixPath(backups),
          POSTGRES_CONTAINER: 'mock-db', POSTGRES_DB: 'postgres', POSTGRES_USER: 'postgres',
          RETENTION_COUNT: options.count ?? '2', MIN_FREE_GB: '15', CHECK_INTERVAL_SECONDS: '1',
          PRUNE_BACKUPS: options.prune ?? 'true', MOCK_MODE: options.mode ?? 'success',
          MOCK_FREE: options.free ?? '100000000000', MOCK_LOCKED: options.locked ? 'true' : 'false',
        },
      })
      result.code = 0
    } catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
    const after = await readdir(backups)
    let calls = ''
    try { calls = await readFile(path.join(root, 'calls'), 'utf8') } catch { /* no calls is expected for preflight failures */ }
    assert.equal(await readFile(path.join(backups, 'unrelated.dump'), 'utf8'), 'KEEP')
    assert.equal(await readFile(path.join(backups, 'climactiva-crm-20000101-030001.dump.partial'), 'utf8'), 'KEEP-PARTIAL')
    const completed = after.filter((name) => /^climactiva-crm-\d{8}-\d{6}\.dump$/.test(name))
    const currentPartials = after.filter((name) => name.endsWith('.partial') && name !== 'climactiva-crm-20000101-030001.dump.partial')
    assert.deepEqual(currentPartials, [], result.stderr)
    return { ...result, before, after, calls, completed }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('crm-backup-test-'))
    await rm(root, { recursive: true, force: true })
  }
}

test('plan is read only, does not contact Docker or create a lock', async () => {
  const result = await scenario({ plan: true })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.after, result.before)
  assert.equal(result.calls, '')
})
test('new and retained dumps verified before keeping only the latest two', async () => {
  const result = await scenario()
  assert.equal(result.code, 0, result.stderr + result.stdout)
  assert.equal(result.completed.length, 2)
  assert.ok(result.completed.includes(oldNames[2]))
  assert.equal((result.calls.match(/pg_restore/g) ?? []).length, 2)
  assert.equal(result.after.filter((name) => name.endsWith('.sha256')).length, 2)
})
for (const mode of ['fail', 'empty', 'corrupt']) {
  test(`${mode} dump never deletes completed backups`, async () => {
    const result = await scenario({ mode })
    assert.notEqual(result.code, 0)
    assert.deepEqual(result.completed, oldNames)
  })
}
test('corrupt keeper blocks all historical pruning', async () => {
  const result = await scenario({ badKeeper: true })
  assert.notEqual(result.code, 0)
  assert.equal(result.completed.length, 4)
  for (const old of oldNames) assert.ok(result.completed.includes(old))
})
test('disabled policy creates a verified copy but deletes nothing', async () => {
  const result = await scenario({ prune: 'false' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.completed.length, 4)
})
test('insufficient disk prevents dump and pruning', async () => {
  const result = await scenario({ free: '16000000000' })
  assert.equal(result.code, 3, result.stderr)
  assert.equal(result.calls, '')
  assert.deepEqual(result.completed, oldNames)
})
test('reserve guard cancels only tagged backup and removes its partial', async () => {
  const result = await scenario({ mode: 'guard' })
  assert.equal(result.code, 3, result.stderr)
  assert.match(result.calls, /pg_cancel_backend.*application_name = 'crm_backup_/)
  assert.deepEqual(result.completed, oldNames)
})
test('held lock prevents second backup', async () => {
  const result = await scenario({ locked: true })
  assert.equal(result.code, 75, result.stderr)
  assert.equal(result.calls, '')
})
test('cannot configure fewer than two retained copies', async () => {
  const result = await scenario({ count: '1' })
  assert.equal(result.code, 2)
  assert.deepEqual(result.after, result.before)
})
test('future timestamps block pruning', async () => {
  const result = await scenario({ future: true })
  assert.notEqual(result.code, 0)
  assert.equal(result.completed.length, 5)
})
test('concurrent changes to an old archive stop pruning', async () => {
  const result = await scenario({ mode: 'concurrent' })
  assert.notEqual(result.code, 0)
  assert.equal(result.completed.length, 4)
})
