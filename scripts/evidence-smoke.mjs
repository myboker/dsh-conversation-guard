// Offline integration against a real DSH profile; all model responses and jobs are synthetic.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bindGuardTask } from '../../dsh-superagent-prototype/lib/index.js'
export const name = 'guard-evidence-smoke'
export const inject = ['agents', 'llm', 'tools', 'jobs', 'commands', 'conversationGuard', 'sessionPersistence']
export function apply(ctx) {
  let requests = 0, finishJob, jobId
  const output = 'A-PAYLOAD ' + 'x'.repeat(18000) + ' FINAL-A-SUFFIX'
  ctx.tools.register(defineTool({ name: 'guard_evidence_fixture', description: 'Synthetic test output; no filesystem or network effects', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, execution) {
      jobId = ctx.jobs.start({ owner: execution.agent.session.id, kind: 'bash', label: 'Synthetic in-memory deferred job',
        toolCall: { callId: execution.callId, rootCallId: execution.rootCallId },
        run: () => ({ done: new Promise(resolve => { finishJob = resolve }), cancel: () => finishJob({ status: 'killed' }) }) })
      return output
    } }))
  class RecordedModel extends LlmAdapter {
    async *stream() {
      requests++
      if (requests === 1) {
        const block = { type: 'tool-call', id: randomUUID(), name: 'guard_evidence_fixture', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = requests === 2 ? 'Completed request A.' : 'UNRELATED-B-PRIVATE'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['evidence-smoke'], new RecordedModel())
  const command = async (agent, text) => {
    const answer = await ctx.commands.execute(agent, `/guard ${text}`, [], new AbortController().signal)
    assert.equal(answer.result.kind, 'success', answer.result.text)
    return answer.result.text
  }
  const tool = async (agent, name, args) => {
    const result = (await ctx.tools.execute({ agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }] })).results[0].result
    return result
  }
  const run = async () => {
    if (process.env.GUARD_EVIDENCE_RESTART === '1') {
      const saved = JSON.parse(readFileSync('.test-home/evidence-restart.json', 'utf8'))
      const owned = await ctx.agents.resume({ resumeSessionId: saved.sessionId })
      const index = await command(owned.agent, `evidence ${saved.handoffId}`)
      assert.match(index, /tool\/result/)
      const page = await command(owned.agent, `evidence ${saved.handoffId} ${saved.resultCursor}`)
      assert.match(page, /A-PAYLOAD/); assert.ok(!page.includes('UNRELATED-B-PRIVATE'))
      assert.equal(requests, 0, 'inspection must not call a model')
      await owned.dispose()
      console.log('GUARD_EVIDENCE_RESTART_PASS'); return
    }
    const owned = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'evidence-smoke', model: 'offline' } })
    const agent = owned.agent
    agent.ctx.tools.restrict({ allow: ['guard_evidence_fixture', 'conversation_guard_handoff', 'conversation_guard_evidence'] })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Request A: inspect synthetic login fixture.' }] }))
    await agent.whenIdle()
    assert.equal(requests, 2); assert.ok(jobId)
    const batchId = (await command(agent, 'history')).split(' ')[0]
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Request B: UNRELATED-B-PRIVATE' }] }))
    await agent.whenIdle()
    const pending = ctx.conversationGuard.pending(agent.session.id)
    assert.equal(pending.state, 'held')
    await command(agent, `allow ${pending.token}`); await agent.whenIdle()
    assert.equal(requests, 3)
    const exported = await tool(agent, 'conversation_guard_handoff', { batch_id: batchId, summary: 'Synthetic A handoff',
      actions: ['Ran the in-memory fixture'], artifacts: [], verification: 'Synthetic assertions only', side_effects: 'Deferred in-memory job has not settled', remaining: 'Review A output' })
    assert.equal(exported.isError, false)
    const document = readFileSync(exported.value, 'utf8'), handoffId = /Handoff: ([\w-]+)/.exec(document)[1]
    assert.ok(document.length < 12000); assert.ok(!document.includes(output)); assert.ok(!document.includes('UNRELATED-B-PRIVATE'))
    assert.match(document, /jobs without a recorded settlement: 1/)
    const index = await command(agent, `evidence ${handoffId}`)
    assert.match(index, /tool\/call/); assert.match(index, /job\/registered/)
    assert.ok(!index.includes('| mixed |'), 'host request boundary must be recorded for actual model dispatch')
    const resultCursor = index.split('\n').find(line => line.includes('tool/result')).match(/read_cursor: (\d+:0)/)[1]
    let cursor = resultCursor, collected = '', pages = 0
    do {
      const result = await tool(agent, 'conversation_guard_evidence', { handoff_id: handoffId, cursor })
      assert.equal(result.isError, false); assert.ok(result.value.length < 4700)
      collected += result.value; pages++
      cursor = /next_cursor: ([^\n]+)/.exec(result.value)[1]
    } while (cursor.startsWith(resultCursor.split(':')[0] + ':'))
    assert.match(collected, /FINAL-A-SUFFIX/); assert.ok(!collected.includes('UNRELATED-B-PRIVATE')); assert.ok(pages > 1)
    const other = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'evidence-smoke', model: 'offline' } })
    assert.equal((await tool(other.agent, 'conversation_guard_evidence', { handoff_id: handoffId })).isError, true)
    await other.dispose()
    const settled = new Promise(resolve => {
      const release = ctx.jobs.events.subscribe({ owner: agent.session.id }, event => {
        if (event.type === 'settled' && event.job.id === jobId) { release(); resolve() }
      })
    })
    finishJob({ status: 'completed', detail: 'Synthetic late completion' }); await settled
    const frozen = await command(agent, `evidence ${handoffId}`)
    assert.ok(!frozen.includes('job/settled'))
    const newerPath = (await command(agent, `handoff ${batchId}`)).replace('Recovery document: ', '')
    const newerDoc = readFileSync(newerPath, 'utf8'), newerId = /Handoff: ([\w-]+)/.exec(newerDoc)[1]
    assert.match(newerDoc, /jobs without a recorded settlement: 0/)
    assert.match(await command(agent, `evidence ${newerId}`), /job\/settled/)
    // Verify the compiled optional bridge still binds a managed scope on this host.
    const ticket = { id: randomUUID(), mandate: { scope: 'Synthetic managed task' }, title: 'Managed', inputs: [] }
    const host = { context: ctx, store: { tickets: { get: () => ticket } }, sessions: {}, engine: {} }
    assert.ok(bindGuardTask(host, ticket))
    await ctx.sessionPersistence.flush()
    writeFileSync('.test-home/evidence-restart.json', JSON.stringify({ sessionId: agent.session.id, handoffId, resultCursor }))
    await owned.dispose()
    mkdirSync('reports', { recursive: true })
    writeFileSync('reports/evidence-smoke.json', JSON.stringify({ passed: true, model: 'offline deterministic adapter', requests, evidencePages: pages,
      checks: ['real agent loop and native tool execution', 'host dispatch boundaries', 'later request excluded', 'bounded summary', 'paged long output',
        'same-session-only evidence', 'frozen export', 'late background-job settlement', 'compiled Super-agent bridge'], sampleDocument: exported.value }, null, 2))
    console.log('GUARD_EVIDENCE_SMOKE_PASS')
  }
  const timeout = setTimeout(() => { console.error('GUARD_EVIDENCE_TIMEOUT'); process.exit(1) }, 30000)
  setTimeout(() => void run().then(() => { clearTimeout(timeout); process.exit(0) }, error => {
    console.error('GUARD_EVIDENCE_FAIL', error.stack); process.exit(1)
  }), 100)
}
