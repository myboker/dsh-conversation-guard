import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
const msg = (id: string, text: string, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })
function fixture(directory = mkdtempSync(join(tmpdir(), 'guard-plugin-')), questions?: any) {
  const events: any[] = [], listeners = new Map<string, any>(), cleanup: any[] = [], queued: any[] = []
  let command: any, guard: any
  const agent: any = { id: 's', session: { id: 's', header: { cwd: '/tmp/synthetic' }, snapshotEvents: () => events }, followup: (message: any) => queued.push(message) }
  const ctx: any = { agents: { get: () => agent }, logger: { warn() {} }, userQuestions: questions,
    get: (name: string) => ctx[name], provide: (name: string, service: any) => { ctx[name] = service },
    on: (name: string, listener: any) => { listeners.set(name, listener) }, effect: (factory: any) => cleanup.push(factory()),
    tools: { register: () => () => {}, guard: (fn: any) => { guard = fn; return () => {} } },
    commands: { register: (value: any) => { command = value.handler; return () => {} } } }
  apply(ctx, { stateDirectory: directory, apiKeyEnv: 'GUARD_PLUGIN_SYNTHETIC', questionTimeoutMs: 100 })
  const step = (messages: any[], next = async () => ({ kind: 'enter', messages })) => listeners.get('agent/pre-step')({ agent, messages, signal: new AbortController().signal }, next)
  const commit = (messages: any[]) => { for (const message of messages) { const event = { type: 'user/message', data: message, seq: events.length, time: Date.now() }; events.push(event); listeners.get('session/event')(agent.session, event) } }
  return { ctx, agent, queued, directory, step, commit, guarded: () => guard({ agent }),
    command: (rawInput: string) => command({ agent, rawInput, signal: new AbortController().signal }),
    close: async (remove = true) => { for (const dispose of cleanup.reverse()) await dispose?.(); if (remove) rmSync(directory, { recursive: true }) } }
}
test('bootstrap preserves downstream messages and series boundary', async () => {
  const h = fixture()
  try {
    const human = msg('a', 'Fix login'); const notice = msg('b', 'trusted context', 'system')
    const result = await h.step([human], async () => ({ kind: 'enter', messages: [human, notice], startsRequestSeries: true }))
    assert.equal(result.startsRequestSeries, true); assert.deepEqual(result.messages.slice(0, 2), [human, notice]); h.commit(result.messages)
    assert.equal(h.ctx.conversationGuard.pending('s'), undefined)
  } finally { await h.close() }
})
test('redelivered committed IDs do not create another model turn or contaminate a new batch', async () => {
  const h = fixture()
  try {
    const message = msg('once', 'Fix login')
    h.commit((await h.step([message])).messages)
    assert.equal((await h.step([message])).kind, 'reject')
    await h.step([message, msg('new', 'Billing')])
    assert.deepEqual(h.ctx.conversationGuard.pending('s').messages.map((item: any) => item.id), ['new'])
  } finally { await h.close() }
})
test('missing classifier key fails closed; ordinary continue invalidates confirmation and never enters the model', async () => {
  const h = fixture()
  try {
    h.commit((await h.step([msg('a', 'Fix login')])).messages)
    assert.equal((await h.step([msg('b', 'Deploy billing')])).kind, 'reject')
    const first = h.ctx.conversationGuard.pending('s')
    assert.match(h.guarded(), /await human/)
    await h.step([msg('c', 'continue')])
    assert.equal((await h.command(`allow ${first.token}`)).kind, 'error')
    const current = h.ctx.conversationGuard.pending('s')
    assert.equal((await h.command(`allow ${current.token}`)).kind, 'success')
    const wake = h.queued.shift()
    const result = await h.step([wake], async () => ({ kind: 'enter', messages: [wake, msg('notice', 'extra', 'system')], startsRequestSeries: true }))
    assert.deepEqual(result.messages.slice(0, 3).map((message: any) => message.id), ['b', 'c', 'notice'])
    assert.equal(result.startsRequestSeries, true)
    h.commit(result.messages); assert.equal(h.guarded(), undefined)
  } finally { await h.close() }
})
test('downstream rejection retains batch; restart requires explicit recovery', async () => {
  const h = fixture(); const directory = h.directory
  await h.step([msg('a', 'Fix login')], async () => ({ kind: 'reject' }))
  const token = h.ctx.conversationGuard.pending('s').token
  await h.close(false)
  const resumed = fixture(directory)
  try {
    assert.equal(resumed.ctx.conversationGuard.pending('s').token, token)
    assert.equal(resumed.queued.length, 0)
    await resumed.command(`allow ${token}`)
    const result = await resumed.step([resumed.queued.shift()])
    assert.equal(result.messages[0].id, 'a')
  } finally { await resumed.close() }
})
test('partial log commit is not replayed twice', async () => {
  const h = fixture()
  try {
    h.commit((await h.step([msg('task', 'Fix login')])).messages)
    await h.step([msg('b', 'billing'), msg('c', 'do it')])
    const pending = h.ctx.conversationGuard.pending('s')
    await h.command(`allow ${pending.token}`)
    h.commit([msg('b', 'billing')])
    const result = await h.step([h.queued.shift()])
    assert.equal(result.messages[0].id, 'c'); assert.equal(result.messages.filter((message: any) => message.id === 'b').length, 0)
    h.commit(result.messages); assert.equal(h.ctx.conversationGuard.pending('s'), undefined)
  } finally { await h.close() }
})
test('cancel during semantic check rejects original batch and stale wake cannot create another model turn', async () => {
  const saved = globalThis.fetch; process.env.GUARD_PLUGIN_SYNTHETIC = 'synthetic'
  const h = fixture()
  try {
    h.commit((await h.step([msg('task', 'Fix login')])).messages)
    globalThis.fetch = async () => {
      const batch = h.ctx.conversationGuard.pending('s')
      await h.command(`cancel ${batch.token}`)
      return Response.json({ choices: [{ message: { content: '{"kind":"in_scope","reason":"ok","evidence":[]}' } }] })
    }
    assert.equal((await h.step([msg('cancelled', 'test')])).kind, 'reject')
    globalThis.fetch = async () => {
      const batch = h.ctx.conversationGuard.pending('s')
      await h.command(`allow ${batch.token}`)
      return Response.json({ choices: [{ message: { content: '{"kind":"in_scope","reason":"ok","evidence":[]}' } }] })
    }
    h.commit((await h.step([msg('once', 'test')])).messages)
    assert.equal((await h.step([h.queued.shift()])).kind, 'reject')
  } finally { globalThis.fetch = saved; delete process.env.GUARD_PLUGIN_SYNTHETIC; await h.close() }
})
test('native question ignores free text and binds selection to exact token', async () => {
  let answer: any, request: any
  const h = fixture(undefined, { ask: (value: any) => { request = value; return new Promise(resolve => { answer = resolve }) } })
  try {
    h.commit((await h.step([msg('task', 'Fix login')])).messages)
    await h.step([msg('wrong', 'Billing')])
    answer({ answers: [{ id: request.questions[0].id, selected: ['继续本批'], custom: 'quoted answer' }] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.queued.length, 0); assert.equal(h.ctx.conversationGuard.pending('s').state, 'held')
    await h.command('review')
    answer({ answers: [{ id: request.questions[0].id, selected: ['继续本批'] }] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(h.queued.length, 1)
  } finally { await h.close() }
})
test('managed bot notices bypass classifier, unregistered managed deliveries fail closed', async () => {
  const h = fixture()
  try {
    h.ctx.conversationGuard.bindTask({ sessionId: 's', taskId: 'T', objective: 'Fix login' })
    h.ctx.conversationGuard.bindInput('s', 'bot', null)
    assert.equal((await h.step([msg('bot', 'CI complete', 'dsh-superagent')])).kind, 'enter')
    assert.equal((await h.step([msg('unknown', 'human?', 'dsh-superagent')])).kind, 'reject')
    assert.equal((await h.command('task unrelated')).kind, 'error')
  } finally { await h.close() }
})
