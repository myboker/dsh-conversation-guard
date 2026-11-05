import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'guard-package-smoke'
export const inject = ['agents', 'llm', 'conversationGuard', 'commands']
export function apply(ctx) {
  let called = false
  class NoRequests extends LlmAdapter { async *stream() { called = true; yield { type: 'finish', reason: { kind: 'stop' } } } }
  ctx.llm.registerAdapter(['package-smoke'], new NoRequests())
  const run = async () => {
    const sessionId = randomUUID()
    ctx.conversationGuard.bindTask({ sessionId, taskId: 'package-test', objective: 'Fix login' })
    const owned = await ctx.agents.create({ sessionId, agentOptions: { provider: 'package-smoke', model: 'none' } })
    owned.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy billing' }] }))
    await owned.agent.whenIdle()
    const pending = ctx.conversationGuard.pending(sessionId)
    assert.equal(pending.state, 'held'); assert.equal(called, false)
    const result = await ctx.commands.execute(owned.agent, `/guard cancel ${pending.token}`, [], new AbortController().signal)
    assert.equal(result.result.kind, 'success')
    await owned.dispose()
    console.log('GUARD_PACKAGED_PLUGIN_PASS')
  }
  setTimeout(() => void run().then(() => process.exit(0), error => { console.error('GUARD_PACKAGE_FAIL', error.message); process.exit(1) }), 100)
}
