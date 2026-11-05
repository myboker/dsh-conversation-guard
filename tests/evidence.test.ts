import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, type Batch, type WorkerHandoff } from '../src/core.js'
import { captureEvidence, handoffDocument, readEvidence, requestBoundary, type EvidenceEvent, type EvidenceManifest, type RequestBoundary } from '../src/evidence.js'

function fixture() {
  const journal = new Journal(':memory:')
  journal.setTask('s', 'Fix login')
  const batch = (id: string) => {
    const item = journal.park('s', [{ id, source: { kind: 'user' }, content: [{ type: 'text', text: `request ${id}` }] }], 0)
    journal.update('s', item.token, { state: 'ready' }); journal.reconcile('s', new Set([id]), 0)
    return journal.get('s', item.id)!
  }
  const a = batch('a'), b = batch('b'), c = batch('c'), events: EvidenceEvent[] = []
  const boundaries: RequestBoundary[] = []
  const append = (type: string, data: unknown) => { const event = { seq: events.length, time: events.length + 1, type, data }; events.push(event); return event.seq }
  const start = (turn: number, step: number, input?: Batch) => {
    if (step === 1) append('turn/start', { turn })
    append('step/start', { turn, step })
    if (input) for (const message of input.messages) append('user/message', message)
  }
  const assistant = (turn: number, step: number, text: string, tool = false) => {
    boundaries.push(requestBoundary(turn, step, events.at(-1)!))
    return append('assistant/message', {
      turn, step, stream: ['PRIVATE-RAW-STREAM'], message: { content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool-call', id: `call-${turn}-${step}` }] : [])] } })
  }
  const end = (turn: number, step: number, close = true) => { append('step/end', { turn, step }); if (close) append('turn/end', { turn, reason: { kind: 'completed' } }) }
  const capture = (target = a, account?: WorkerHandoff) => captureEvidence(target, [a, b, c], events, account, boundaries)
  journal.close()
  return { a, b, c, events, boundaries, append, start, assistant, end, capture }
}
const eventKeys = (manifest: EvidenceManifest) => manifest.refs.filter(ref => ref.source === 'event').map(ref => ref.key)

test('later unrelated requests are excluded; delayed results and jobs retain their creating call', () => {
  const h = fixture()
  h.start(1, 1, h.a); const answer = h.assistant(1, 1, 'A actions', true)
  const call = h.append('tool/call', { turn: 1, step: 1, callId: 'A-call', name: 'bash', arguments: 'A-only' })
  const job = h.append('job/registered', { owner: 's', jobId: 'job-a', toolCall: { rootCallId: 'A-call', callId: 'nested' } })
  h.end(1, 1)
  h.start(2, 1, h.b); const unrelated = h.assistant(2, 1, 'PRIVATE-B')
  h.append('tool/call', { turn: 2, step: 1, callId: 'B-call', name: 'edit', arguments: 'PRIVATE-B' })
  const lateResult = h.append('tool/result', { turn: 1, step: 1, message: { toolCallId: 'A-call', content: ['A result'] } })
  const lateJob = h.append('job/settled', { owner: 's', jobId: 'job-a', status: 'completed' })
  h.append('job/settled', { owner: 'foreign', jobId: 'job-foreign', toolCall: { rootCallId: 'A-call' } })
  h.end(2, 1)
  const manifest = h.capture(), selected = eventKeys(manifest)
  for (const seq of [answer, call, job, lateResult, lateJob]) assert.ok(selected.includes(seq))
  assert.ok(!selected.includes(unrelated)); assert.equal(manifest.counts.mixed, 0)
  assert.equal(manifest.counts.callsWithoutResult, 0); assert.equal(manifest.counts.jobsWithoutSettlement, 0)
  for (let i = 0; i < manifest.refs.length; i++) assert.ok(!readEvidence(manifest, h.a, h.events, `${i}:0`).includes('PRIVATE-B'))
})

test('a new request during a continuing tool turn is marked shared, then a new turn closes that scope', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'A', true); h.end(1, 1, false)
  h.start(1, 2, h.b); const shared = h.assistant(1, 2, 'A+B'); h.end(1, 2)
  h.start(2, 1, h.c); const later = h.assistant(2, 1, 'C'); h.end(2, 1)
  for (const batch of [h.a, h.b]) {
    const manifest = h.capture(batch)
    assert.equal(manifest.refs.find(ref => ref.source === 'event' && ref.key === shared)?.relation, 'mixed')
    assert.ok(!eventKeys(manifest).includes(later))
  }
})

test('multiple requests in the same step and untracked human inputs are explicitly mixed', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.append('user/message', h.b.messages[0]); h.append('user/message', { id: 'unknown', source: { kind: 'user' } })
  const shared = h.assistant(1, 1, 'shared')
  assert.equal(h.capture().refs.find(ref => ref.key === shared && ref.source === 'event')?.relation, 'mixed')
})

test('a completed answer does not attach a later request even within the same turn', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'A complete'); h.end(1, 1, false)
  h.start(1, 2, h.b); const later = h.assistant(1, 2, 'B'); h.end(1, 2)
  assert.ok(!eventKeys(h.capture()).includes(later))
})

test('input injected after an assistant response cannot relabel its tool calls', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'A tool', true)
  h.append('user/message', h.b.messages[0])
  const call = h.append('tool/call', { turn: 1, step: 1, callId: 'old', name: 'edit', arguments: '{}' })
  assert.ok(eventKeys(h.capture()).includes(call)); assert.ok(!eventKeys(h.capture(h.b)).includes(call))
})

test('host dispatch boundary excludes mid-stream injected input; legacy logs are uncertain', () => {
  const h = fixture()
  h.start(1, 1, h.a)
  const boundary = requestBoundary(1, 1, h.events.at(-1)!)
  h.append('user/message', h.b.messages[0])
  const answer = h.assistant(1, 1, 'answer to A')
  h.boundaries.splice(0, h.boundaries.length, boundary)
  assert.ok(!eventKeys(h.capture(h.b)).includes(answer))
  assert.equal(h.capture().refs.find(ref => ref.source === 'event' && ref.key === answer)?.relation, 'step')
  h.boundaries.length = 0
  assert.equal(h.capture().refs.find(ref => ref.source === 'event' && ref.key === answer)?.relation, 'mixed')
})

test('held or legacy batches without committed IDs never claim unrelated activity by time', () => {
  const h = fixture()
  h.start(1, 1, h.b); h.assistant(1, 1, 'B'); h.end(1, 1)
  h.append('tool/result', { turn: 1, step: 1, message: { toolCallId: 'unlinked', content: ['UNKNOWN'] } })
  const manifest = h.capture()
  assert.equal(manifest.counts.events, 0); assert.equal(manifest.counts.missingInputs, 1)
})

test('copied fork history never transfers job or request ownership', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'inherited')
  h.append('session/end-seed', { inherited: true })
  h.append('tool/result', { turn: 1, step: 1, message: { toolCallId: 'inherited', content: ['old'] } })
  assert.equal(h.capture().counts.events, 0)
})

test('snapshot remains fixed, missing/replaced records fail explicitly, unfinished work is not called running', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'A', true)
  const call = h.append('tool/call', { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' })
  h.append('job/registered', { owner: 's', jobId: 'j', toolCall: { rootCallId: 'c' } })
  const manifest = h.capture()
  h.append('tool/result', { message: { toolCallId: 'c', content: ['AFTER SNAPSHOT'] } })
  h.append('job/settled', { owner: 's', jobId: 'j', status: 'completed' })
  assert.equal(manifest.counts.callsWithoutResult, 1); assert.equal(manifest.counts.jobsWithoutSettlement, 1)
  const record = manifest.refs.findIndex(ref => ref.source === 'event' && ref.key === call)
  assert.match(readEvidence(manifest, h.a, [], `${record}:0`), /missing or changed/)
  const changed = h.events.map(event => event.seq === call ? { ...event, data: { text: 'WRONG REPLACEMENT' } } : event)
  assert.ok(!readEvidence(manifest, h.a, changed, `${record}:0`).includes('WRONG REPLACEMENT'))
  assert.equal(h.capture().counts.jobsWithoutSettlement, 0)
  assert.match(handoffDocument(undefined, h.a, manifest), /Live status is unknown/)
})

test('large evidence is paged without losing the suffix or leaking split credentials, default report is bounded', () => {
  const h = fixture()
  h.start(1, 1, h.a); h.assistant(1, 1, 'A', true)
  h.append('tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' })
  const result = h.append('tool/result', { message: { toolCallId: 'c', content: ['x'.repeat(3900) + 'sk-syntheticlongsecret0123456789 ' + 'y'.repeat(24000) + 'FINAL-SUFFIX'] } })
  const account = { summary: 's'.repeat(8000), actions: Array(50).fill('a'.repeat(2000)), artifacts: Array(50).fill('b'.repeat(2000)), verification: 'v'.repeat(8000), sideEffects: 'e'.repeat(8000), remaining: 'r'.repeat(8000) }
  const manifest = h.capture(h.a, account), report = handoffDocument(undefined, h.a, manifest)
  assert.ok(report.length < 12000); assert.ok(!report.includes('FINAL-SUFFIX')); assert.match(report, /abridged/)
  const index = manifest.refs.findIndex(ref => ref.source === 'event' && ref.key === result)
  let cursor = `${index}:0`, pages = ''
  do {
    const page = readEvidence(manifest, h.a, h.events, cursor)
    assert.ok(page.length < 4700); pages += page
    cursor = /next_cursor: ([^\n]+)/.exec(page)![1]!
  } while (cursor.startsWith(`${index}:`))
  assert.ok(pages.includes('FINAL-SUFFIX')); assert.ok(!pages.includes('syntheticlongsecret')); assert.ok(pages.includes('REDACTED_KEY'))
  const assistantIndex = manifest.refs.findIndex(ref => ref.type === 'assistant/message')
  assert.ok(!readEvidence(manifest, h.a, h.events, `${assistantIndex}:0`).includes('PRIVATE-RAW-STREAM'))
})

test('index pages and scoped cursors reject arbitrary records and cross-session reads', () => {
  const h = fixture(); h.start(1, 1, h.a)
  for (let i = 0; i < 45; i++) h.append('tool/call', { turn: 1, step: 1, callId: String(i), name: 'read' })
  const manifest = h.capture()
  assert.match(readEvidence(manifest, h.a, h.events), /next_cursor: index:20/)
  assert.match(readEvidence(manifest, h.a, h.events, 'index:20'), /read_cursor: 20:0/)
  for (const cursor of ['-1:0', '0:-1', '999:0', '0:99999999', 'NaN', 'index:999']) assert.throws(() => readEvidence(manifest, h.a, h.events, cursor), /cursor|offset/)
  assert.throws(() => readEvidence(manifest, { ...h.a, sessionId: 'other' }, h.events), /scope/)
})

test('immutable reference manifest survives a database reopen with session access checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-evidence-')), path = join(dir, 'journal.db')
  try {
    const h = fixture(); h.start(1, 1, h.a); h.assistant(1, 1, 'saved')
    const manifest = h.capture()
    let journal = new Journal(path); journal.saveHandoff(manifest)
    journal.saveBoundary('s', h.boundaries[0]!)
    assert.throws(() => journal.saveHandoff(manifest)); journal.close()
    journal = new Journal(path)
    assert.deepEqual(journal.handoff('s', manifest.id), manifest); assert.equal(journal.handoff('foreign', manifest.id), undefined)
    assert.deepEqual(journal.boundaries('s'), h.boundaries); assert.deepEqual(journal.boundaries('foreign'), [])
    journal.close()
  } finally { rmSync(dir, { recursive: true }) }
})
