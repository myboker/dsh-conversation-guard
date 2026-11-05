import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bindGuardTask, guardConfirmation } from '../../dsh-superagent-prototype/lib/index.js'

export const name = 'guard-smoke-driver'
export const inject = ['agents', 'llm', 'conversationGuard', 'commands', 'tools', 'sessionPersistence']
export function apply(ctx) {
  let requests = 0
  let toolRuns = 0
  ctx.tools.register(defineTool({ name: 'guard_smoke_counter', description: 'Synthetic in-memory test tool', parameters: {},
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { return ++toolRuns } }))
  class RecordedModel extends LlmAdapter {
    async *stream() {
      requests++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Synthetic worker completed.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic worker completed.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['guard-smoke'], new RecordedModel())
  const run = async () => {
    if (process.env.GUARD_RESTART_SMOKE === '1') {
      const saved = JSON.parse(readFileSync('.test-home/restart-case.json', 'utf8'))
      const resumed = await ctx.agents.resume({ resumeSessionId: saved.sessionId })
      const pending = ctx.conversationGuard.pending(saved.sessionId)
      assert.equal(pending.token, saved.token)
      assert.equal(pending.messages[0].id, saved.messageId)
      assert.equal(resumed.agent.status, 'idle', 'restart must not auto-execute held messages')
      const result = await ctx.commands.execute(resumed.agent, `/guard cancel ${pending.token}`, [], new AbortController().signal)
      assert.equal(result.result.kind, 'success')
      assert.equal(ctx.conversationGuard.pending(saved.sessionId), undefined)
      await ctx.sessionPersistence.flush(); await resumed.dispose()
      writeFileSync('reports/restart-smoke.json', JSON.stringify({ passed: true, checks: ['new host process', 'persisted session resumed', 'exact pending token and original message recovered', 'no automatic replay', 'human cancellation after restart'] }, null, 2))
      console.log('GUARD_RESTART_SMOKE_PASS'); return
    }
    const owned = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() }, agentOptions: { provider: 'guard-smoke', model: 'test', maxTokens: 100 } })
    const agent = owned.agent
    const send = async text => {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      agent.followup(message); await agent.whenIdle(); return message
    }
    await send('修复 web-auth 仓库登录页的表单校验')
    assert.equal(requests, 1, 'bootstrap must enter the real agent loop')
    await send('顺便补上空密码的回归测试')
    assert.equal(requests, 2, 'normal followup must reach the worker')
    const wrong = await send('把 billing-worker 仓库的月末清算任务改成每小时一次')
    assert.equal(requests, 2, 'misroute must NOT reach worker')
    const first = ctx.conversationGuard.pending(agent.session.id)
    assert.equal(first.state, 'held')
    const toolCall = owner => ctx.tools.execute({ agent: owner, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: randomUUID(), name: 'guard_smoke_counter', arguments: '{}' }] })
    await toolCall(agent)
    assert.equal(toolRuns, 0, 'held session must not execute a tool')
    const unrelated = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'guard-smoke', model: 'test' } })
    await toolCall(unrelated.agent)
    assert.equal(toolRuns, 1, 'other sessions must remain usable')
    await unrelated.dispose()
    const reply = await send('继续')
    assert.equal(requests, 2, 'ordinary continue cannot approve')
    const batch = ctx.conversationGuard.pending(agent.session.id)
    assert.notEqual(batch.token, first.token)
    assert.throws(() => ctx.conversationGuard.resolve(agent, first.token, 'allow'), /expired/)
    const approved = await ctx.commands.execute(agent, `/guard allow ${batch.token}`, [], new AbortController().signal)
    assert.equal(approved.result.kind, 'success')
    await agent.whenIdle()
    assert.equal(requests, 3, 'only explicit human command releases the complete batch')
    const committed = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    assert.equal(committed.filter(event => event.data.id === wrong.id).length, 1)
    assert.equal(committed.filter(event => event.data.id === reply.id).length, 1)
    assert.equal(ctx.conversationGuard.pending(agent.session.id), undefined)
    const report = await ctx.commands.execute(agent, `/guard handoff ${batch.id}`, [], new AbortController().signal)
    assert.equal(report.result.kind, 'success')
    await send('去 paper-draft 仓库重写论文摘要并提交修改')
    const cancellation = ctx.conversationGuard.pending(agent.session.id)
    assert.equal(cancellation.state, 'held')
    await ctx.commands.execute(agent, `/guard cancel ${cancellation.token}`, [], new AbortController().signal)
    assert.equal(requests, 3)
    const recovery = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{ type: 'tool-call', id: randomUUID(),
      name: 'conversation_guard_handoff', arguments: JSON.stringify({ batch_id: batch.id,
        summary: 'Synthetic recovery account', actions: ['Read the synthetic request'], artifacts: [], verification: 'No build was run',
        side_effects: 'No external writes in this synthetic test', remaining: 'Ask the intended agent to inspect the request' }) }] })
    const recoveryResult = recovery.results[0].result
    assert.equal(recoveryResult.isError, false)
    const recoveryText = readFileSync(recoveryResult.value, 'utf8')
    assert.match(recoveryText, /Synthetic recovery account/)
    assert.match(recoveryText, /not independently verified/)
    assert.match(recoveryText, /billing-worker/)
    await owned.dispose()
    // Exercise the actual compiled Super-agent bridge against the same live guard and DSH agent.
    const ticketId = randomUUID(), managedId = `worker-${ticketId}`
    const managed = await ctx.agents.create({ sessionId: managedId, agentOptions: { provider: 'guard-smoke', model: 'test' } })
    const original = { id: 'source-request', human: true, actor: { source: 'synthetic', id: 'alice' }, threads: [{ source: 'synthetic', id: 'thread' }], text: '把 billing-worker 仓库的月末清算任务改成每小时一次' }
    const input = { id: 'managed-input', kind: 'trigger', triggerId: original.id }
    const ticket = { id: ticketId, title: '修复登录校验', mandate: { scope: '修复 web-auth 仓库登录页的表单校验' }, inputs: [input], origin: { triggerId: 'initial-request' } }
    const triggers = new Map([[original.id, original]])
    const reports = []
    const host = { context: ctx, store: { tickets: { get: () => ticket }, triggers: { get: id => triggers.get(id) } },
      sessions: { promptedId: id => id }, engine: { report: (_id, report) => { reports.push(report); if (report.question) ticket.attention = { question: report.question, triggerId: report.askedBy }; else if (report.question === null) delete ticket.attention }, inputsRead() {} } }
    const bridge = bindGuardTask(host, ticket)
    bridge.bindInput(managedId, input.id, { text: original.text, supported: true })
    const managedMessage = createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ trigger_id: original.id, text: original.text }) }], source: { kind: 'dsh-superagent' } })
    managed.agent.followup({ ...managedMessage, id: input.id }); await managed.agent.whenIdle()
    const held = bridge.pending(managedId)
    assert.equal(held.state, 'held'); assert.equal(reports.at(-1).askedBy, original.id)
    const confirmation = { ...original, id: 'source-confirmation', text: `!guard allow ${held.token}` }
    triggers.set(confirmation.id, confirmation)
    assert.equal(guardConfirmation(host, ticket, { kind: 'trigger', id: 'confirm-input', triggerId: confirmation.id }, bridge), true)
    await managed.agent.whenIdle()
    assert.equal(bridge.pending(managedId), undefined)
    assert.equal(ticket.mandate.scope, '修复 web-auth 仓库登录页的表单校验')
    await managed.dispose()

    // Two genuine DeepSeek worker responses, with all tools disabled, then a blocked misroute.
    const live = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'off', maxTokens: 128 } })
    const unrestrict = live.agent.ctx.tools.restrict({ allow: [] })
    const timeout = setTimeout(() => live.agent.cancel(), 45000)
    const liveSend = async text => { live.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await live.agent.whenIdle() }
    await liveSend('当前任务：解释登录表单校验。请用一句话说明空密码为什么应被拒绝。不调用工具。')
    const assistants = () => live.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    assert.equal(assistants().length, 1, 'official DeepSeek adapter must produce a real response')
    await liveSend('邮箱格式错误也需要拒绝吗？仅回答一句话。')
    assert.equal(assistants().length, 2)
    await liveSend('把 billing-worker 仓库的月末清算任务改成每小时一次')
    assert.equal(assistants().length, 2, 'misroute must not call the real worker')
    assert.equal(ctx.conversationGuard.pending(live.agent.session.id).state, 'held')
    const retained = ctx.conversationGuard.pending(live.agent.session.id)
    writeFileSync('.test-home/restart-case.json', JSON.stringify({ sessionId: live.agent.session.id, token: retained.token, messageId: retained.messages[0].id }))
    await ctx.sessionPersistence.flush()
    clearTimeout(timeout); unrestrict(); await live.dispose()
    mkdirSync('reports', { recursive: true })
    writeFileSync('reports/profile-smoke.json', JSON.stringify({ passed: true, worker: 'deterministic adapter plus 2 official DeepSeek responses', classifier: 'deepseek-v4-pro', requests, checks: ['boot', 'normal admission', 'misroute hold', 'ordinary continue held', 'stale confirmation rejected', 'explicit approval', 'no duplicate replay', 'handoff export', 'worker-authored recovery with host evidence', 'cancellation', 'held tools denied', 'other sessions unaffected', 'compiled Super-agent bridge', 'original-channel simulated confirmation', 'real DeepSeek worker admission'] }, null, 2))
    console.log('GUARD_PROFILE_SMOKE_PASS')
  }
  // Wait until profile startup settles. This is a test-only profile consumer.
  setTimeout(() => void run().then(() => process.exit(0), error => { console.error('GUARD_PROFILE_SMOKE_FAIL', error.message); process.exit(1) }), 100)
}
