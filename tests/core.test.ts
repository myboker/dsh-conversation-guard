import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, inspectBatch, type Envelope, type Verdict } from '../src/core.js'
import { captureEvidence, handoffDocument } from '../src/evidence.js'

const message = (id: string, text = 'Fix the login tests'): Envelope => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text }] })
const verdict = (kind: Verdict['kind']): Verdict => ({ kind, reason: 'Concrete task comparison', evidence: ['login versus billing'] })
const setup = () => { const journal = new Journal(':memory:'); journal.setTask('s', 'Fix login', { directory: '/tmp/login' }); return journal }
const candidate = { text: 'Fix login tests', supported: true }
const signal = new AbortController().signal

test('normal followup passes, admission requires every original message ID', async () => {
  const journal = setup(); const batch = journal.park('s', [message('m'), message('n')], 5)
  await inspectBatch(journal, batch, [candidate], async () => verdict('in_scope'), signal)
  journal.reconcile('s', new Set(['m']), 8); assert.equal(journal.active('s')?.state, 'ready')
  journal.reconcile('s', new Set(['m', 'n']), 9); assert.equal(journal.active('s'), undefined)
  assert.equal(journal.get('s', batch.id)?.state, 'admitted'); journal.close()
})
for (const kind of ['suspected_misroute', 'explicit_switch', 'uncertain'] as const) {
  test(`${kind} is held without contaminating task identity`, async () => {
    const journal = setup(); const batch = journal.park('s', [message('m', 'Change billing')], 5)
    const result = await inspectBatch(journal, batch, [candidate], async task => { assert.equal(task.objective, 'Fix login'); return verdict(kind) }, signal)
    assert.equal(result.state, 'held'); assert.equal(journal.task('s')?.objective, 'Fix login'); journal.close()
  })
}
test('provider error retains complete message without storing secret-bearing error', async () => {
  const journal = setup(); const batch = journal.park('s', [message('m')], 5)
  const result = await inspectBatch(journal, batch, [candidate], async () => { throw new Error('Bearer private-token') }, signal)
  assert.equal(result.state, 'held'); assert.equal(result.messages[0]?.id, 'm'); assert.ok(!JSON.stringify(result).includes('private-token')); journal.close()
})
test('aborted check holds', async () => {
  const journal = setup(); const batch = journal.park('s', [message('m')], 5)
  const result = await inspectBatch(journal, batch, [candidate], async () => verdict('in_scope'), AbortSignal.abort())
  assert.equal(result.state, 'held'); journal.close()
})
for (const action of ['ready', 'cancelled'] as const) test(`human ${action} during classification cannot be overwritten`, async () => {
  const journal = setup(); const batch = journal.park('s', [message('m')], 5)
  const result = await inspectBatch(journal, batch, [candidate], async () => {
    journal.update('s', batch.token, { state: action, approvedBy: 'human' })
    return verdict('suspected_misroute')
  }, signal)
  assert.equal(result.state, action); journal.close()
})
test('attachments and oversized text require manual review instead of silent truncation', async () => {
  for (const input of [{ text: 'image', supported: false }, { text: 'x'.repeat(24001), supported: true }]) {
    const journal = setup(); const batch = journal.park('s', [message('m')], 5)
    const result = await inspectBatch(journal, batch, [input], async () => { throw new Error('must not call') }, signal)
    assert.match(result.reason, /manual review/); journal.close()
  }
})
test('new input invalidates the exact earlier approval token, preserves dependent suffix', () => {
  const journal = setup(); const batch = journal.park('s', [message('a')], 5)
  journal.update('s', batch.token, { state: 'ready', approvedBy: 'human' })
  const joined = journal.park('s', [message('b', 'Do it')], 6)
  assert.deepEqual(joined.messages.map(message => message.id), ['a', 'b']); assert.equal(joined.state, 'held')
  assert.throws(() => journal.update('s', batch.token, { state: 'ready' }), /Stale/)
  assert.throws(() => journal.update('another-session', joined.token, { state: 'ready' }), /Stale/); journal.close()
})
test('duplicates do not change tokens and ID collisions are rejected', () => {
  const journal = setup(); const batch = journal.park('s', [message('a')], 5)
  assert.equal(journal.park('s', [message('a')], 5).token, batch.token)
  assert.throws(() => journal.park('s', [message('a', 'different')], 6), /reused/); journal.close()
})
test('held state and task survive reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-')); const path = join(dir, 'state.db')
  let journal = new Journal(path); journal.setTask('s', 'Fix login')
  const batch = journal.park('s', [message('a')], 1); journal.close()
  journal = new Journal(path); assert.deepEqual(journal.active('s'), batch)
  assert.equal(journal.task('s')?.objective, 'Fix login'); journal.close(); rmSync(dir, { recursive: true })
})
test('scope cannot change while pending; managed mandate cannot be changed', () => {
  const journal = setup(); const batch = journal.park('s', [message('a')], 5)
  assert.throws(() => journal.setTask('s', 'New work'), /pending/)
  journal.update('s', batch.token, { state: 'cancelled' }); assert.equal(journal.setTask('s', 'New work').revision, 2)
  journal.setTask('worker', 'One mandate', { immutable: true, taskId: 'T1' })
  assert.throws(() => journal.setTask('worker', 'Other mandate', { immutable: true, taskId: 'T1' }), /immutable/); journal.close()
})
test('cancellation does not grant permission or cross-session access', () => {
  const journal = setup(); const batch = journal.park('s', [message('a')], 5)
  journal.update('s', batch.token, { state: 'cancelled' }); assert.equal(journal.active('s'), undefined)
  assert.equal(journal.get('other', batch.id), undefined)
  assert.throws(() => journal.update('s', batch.token, { state: 'ready' }), /Stale/); journal.close()
})
test('managed delivery is typed host metadata, persistent, immutable, and session scoped', () => {
  const journal = setup(); journal.bindInput('s', 'm', candidate)
  assert.deepEqual(journal.input('s', 'm'), candidate); assert.equal(journal.input('other', 'm'), undefined)
  assert.throws(() => journal.bindInput('s', 'm', null), /changed/); journal.close()
})
test('handoff preserves original task revision and never falls back to a time window', () => {
  const journal = setup(); const batch = journal.park('s', [message('m')], 5)
  journal.update('s', batch.token, { state: 'cancelled' }); journal.setTask('s', 'Completely different')
  const manifest = captureEvidence(batch, [batch], [
    { seq: 4, time: 1, type: 'tool/call', data: { name: 'outside-window' } },
    { seq: 8, time: 2, type: 'tool/call', data: { name: 'write', arguments: { path: 'a.ts', token: 'sk-syntheticsecret01234567' } } },
    { seq: 9, time: 3, type: 'tool/result', data: { result: 'failed' } },
  ])
  const report = handoffDocument(journal.task('s'), batch, manifest)
  assert.match(report, /Fix login/); assert.ok(!report.includes('Completely different'))
  assert.ok(!report.includes('a.ts')); assert.match(report, /unknown/); assert.equal(manifest.counts.events, 0)
  assert.ok(!report.includes('outside-window')); assert.ok(!report.includes('sk-synthetic')); journal.close()
})
