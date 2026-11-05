// Reproducible offline demo. All state and fixture edits live in a fresh DSH_HOME.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'dsh-guard-demo-'))
const output = resolve(process.env.GUARD_DEMO_OUTPUT || join(root, 'reports', 'demo'))
mkdirSync(output, { recursive: true })
const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', GUARD_DEMO_OUTPUT: output, GUARD_DEMO_KEY: 'synthetic-demo-placeholder' }
delete env.DEEPSEEK_API_KEY
const run = (args, label, extra = {}) => {
  const result = spawnSync(process.execPath, [dsh, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 90000 })
  writeFileSync(join(output, label + '.log'), (result.stdout || '') + (result.stderr || ''))
  if (result.status !== 0) { console.error(`Demo failed at ${label}. See ${join(output, label + '.log')}`); process.exit(1) }
}
const packageArg = process.argv.indexOf('--package')
const tarball = packageArg >= 0 ? resolve(process.argv[packageArg + 1]) : undefined
run(['plugin', '--profile', 'guard-demo', ...(tarball ? ['add', tarball] : ['list'])], 'install')
const guard = { id: 'conversation-guard', ...(tarball ? {} : { name: join(root, 'lib', 'index.js') }),
  config: { stateDirectory: join(home, 'guard-state'), apiKeyEnv: 'GUARD_DEMO_KEY', baseUrl: 'https://conversation-guard-demo.invalid', questionTimeoutMs: 100 } }
const patch = [
  { id: 'session-telemetry-otel', disabled: true }, { id: 'session-title-llm', disabled: true },
  ...(tarball ? [guard] : []),
  { insert: [...(tarball ? [] : [guard]), { id: 'guard-demo-driver', name: join(root, 'scripts', 'demo-driver.mjs') }] },
]
const patchFile = join(home, 'demo.patch.yml')
writeFileSync(patchFile, JSON.stringify(patch, null, 2))
run(['--profile', 'guard-demo', '--patch', patchFile], 'demo')
run(['--profile', 'guard-demo', '--patch', patchFile], 'restart', { GUARD_DEMO_RESTART: '1' })
writeFileSync(join(output, 'environment.json'), JSON.stringify({ dshHome: home, node: process.version, tarball: tarball || null }, null, 2))
console.log(`DEMO_AND_RESTART_PASS\nRecorded output: ${output}\nIsolated state and fixture: ${home}`)
