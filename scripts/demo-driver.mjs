// Real DSH execution, scripted classifier/worker responses. No paid API calls.
// Loaded only by scripts/demo.mjs, never by the published plugin bundle.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'conversation-guard-demo'
export const inject = ['agents', 'llm', 'tools', 'commands', 'conversationGuard', 'sessionPersistence']

export function apply(ctx) {
  const home = process.env.DSH_HOME
  const output = process.env.GUARD_DEMO_OUTPUT
  const workspace = join(home, 'demo-workspace')
  const fixture = join(workspace, 'billing-worker', 'schedule.json')
  mkdirSync(join(workspace, 'billing-worker'), { recursive: true })
  const entries = []
  let workerCalls = 0, toolRuns = 0, mode = 'login', nextTool = false, missed = false
  const record = (title, body) => { entries.push({ title, body }); console.log(`\n## ${title}\n${body}`) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://conversation-guard-demo.invalid/chat/completions', 'demo must not make external requests')
    const request = JSON.parse(String(options.body))
    const { candidate } = JSON.parse(request.messages[1].content)
    const wrong = candidate.includes('billing-worker') && !missed
    const result = wrong
      ? { kind: 'suspected_misroute', reason: '当前任务是 web-auth 登录校验；这条请求要求修改 billing-worker 的清算调度。', evidence: ['billing-worker'] }
      : { kind: 'in_scope', reason: missed ? 'Scripted false negative for the recovery demonstration.' : 'Scripted relevant login follow-up.', evidence: [] }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  }

  const longOutput = 'Fixture change: monthly -> hourly\n' + 'Synthetic evidence line.\n'.repeat(850) + 'END-OF-SCOPED-EVIDENCE'
  ctx.tools.register(defineTool({ name: 'guard_demo_schedule', description: 'Change only the isolated demo fixture; no production effects.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { toolRuns++; writeFileSync(fixture, JSON.stringify({ schedule: 'hourly' }) + '\n'); return longOutput } }))
  class DemoWorker extends LlmAdapter {
    async *stream() {
      workerCalls++
      if (nextTool) {
        nextTool = false
        const block = { type: 'tool-call', id: randomUUID(), name: 'guard_demo_schedule', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = mode === 'billing' ? 'Changed the isolated billing fixture to hourly.'
          : mode === 'unrelated' ? 'UNRELATED-LOGIN-FOLLOWUP: password validation checked.' : 'Synthetic login validation response.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['conversation-guard-demo'], new DemoWorker())
  const execute = async (agent, text, success = true) => {
    const answer = await ctx.commands.execute(agent, `/guard ${text}`, [], new AbortController().signal)
    assert.equal(answer.result.kind, success ? 'success' : 'error', answer.result.text)
    return answer.result.text
  }
  const tool = async (agent, name, args = {}) => (await ctx.tools.execute({ agent, signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }] })).results[0].result
  const create = () => ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: workspace }, agentOptions: { provider: 'conversation-guard-demo', model: 'scripted-offline' } })
  const run = async () => {
    if (process.env.GUARD_DEMO_RESTART === '1') {
      const saved = JSON.parse(readFileSync(join(output, 'restart.json'), 'utf8'))
      const owned = await ctx.agents.resume({ resumeSessionId: saved.sessionId })
      const page = await execute(owned.agent, `evidence ${saved.handoffId} ${saved.cursor}`)
      assert.match(page, /Fixture change/)
      const pending = ctx.conversationGuard.pending(saved.sessionId)
      assert.equal(pending.token, saved.token)
      assert.equal(workerCalls, 0)
      await execute(owned.agent, `cancel ${pending.token}`)
      await ctx.sessionPersistence.flush(); await owned.dispose()
      writeFileSync(join(output, 'restart-result.json'), JSON.stringify({ passed: true, workerCalls, pendingBatchRecovered: true, evidenceRecovered: true }, null, 2))
      console.log('DEMO_RESTART_PASS: pending batch and scoped evidence recovered; no model execution.')
      return
    }
    writeFileSync(fixture, JSON.stringify({ schedule: 'monthly' }) + '\n')
    const owned = await create(), agent = owned.agent
    agent.ctx.tools.restrict({ allow: ['guard_demo_schedule', 'conversation_guard_handoff', 'conversation_guard_evidence'] })
    const send = async text => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle() }
    record('Demo setup / 演示条件', 'Real DSH agent loop and installed plugin. Classifier and worker replies are scripted fixtures, NOT a live model accuracy test. Only an isolated local file can be changed.')
    await send('修复 web-auth 仓库登录页的表单校验')
    await send('顺便补上空密码的回归测试')
    assert.equal(workerCalls, 2)
    record('1. Normal follow-up / 正常跟进', `${await execute(agent, 'status')}\nWorker calls: ${workerCalls}`)
    const wrong = '把 billing-worker 仓库的月末清算任务改成每小时一次'
    await send(wrong)
    const first = ctx.conversationGuard.pending(agent.session.id)
    assert.equal(first.state, 'held'); assert.equal(workerCalls, 2)
    record('2. Misrouted message held / 串台消息暂停', `${await execute(agent, 'status')}\nWorker calls remain: ${workerCalls}`)
    await tool(agent, 'guard_demo_schedule'); assert.equal(toolRuns, 0)
    const other = await create()
    assert.equal((await tool(other.agent, 'conversation_guard_evidence', { handoff_id: 'nonexistent' })).isError, true)
    // An independent session can still execute an allowed, harmless local fixture tool.
    await tool(other.agent, 'guard_demo_schedule'); assert.equal(toolRuns, 1)
    await other.dispose(); writeFileSync(fixture, JSON.stringify({ schedule: 'monthly' }) + '\n')
    await send('继续')
    const pending = ctx.conversationGuard.pending(agent.session.id)
    assert.notEqual(pending.token, first.token); assert.equal(workerCalls, 2)
    await execute(agent, `allow ${first.token}`, false)
    const cancelled = await execute(agent, `cancel ${pending.token}`)
    await send(wrong)
    const approved = ctx.conversationGuard.pending(agent.session.id)
    const approval = await execute(agent, `allow ${approved.token}`)
    await agent.whenIdle()
    assert.equal(workerCalls, 3); assert.equal(ctx.conversationGuard.pending(agent.session.id), undefined)
    record('3. Human decision / 人类确认', `Plain “继续” did not release the batch. Old token rejected.\n${cancelled}\nA separately resubmitted batch was explicitly approved:\n${approval}\nWorker calls: ${workerCalls}\nHeld session tool calls blocked; independent session remained usable.`)

    missed = true; mode = 'billing'; nextTool = true
    await send(wrong)
    const history = await execute(agent, 'history')
    const batchId = history.trim().split('\n').at(-1).split(' ')[0]
    assert.equal(JSON.parse(readFileSync(fixture, 'utf8')).schedule, 'hourly')
    assert.equal(workerCalls, 5)
    record('4. Simulated missed detection / 漏判后的实际操作', 'Classifier deliberately returns in_scope for this demo.\nReal tool execution changed the isolated fixture: billing-worker/schedule.json\nBefore: monthly\nAfter: hourly\nThis is a controlled fixture, not a production repository.')
    missed = false; mode = 'unrelated'
    await send('继续检查登录表单的密码校验')
    assert.equal(workerCalls, 6)
    const handoff = await tool(agent, 'conversation_guard_handoff', { batch_id: batchId,
      summary: 'A billing schedule request ran in the login conversation. This account is supplied by the offline demo driver.',
      actions: ['Changed isolated demo-workspace/billing-worker/schedule.json from monthly to hourly'],
      artifacts: ['demo-workspace/billing-worker/schedule.json'], verification: 'Demo assertion read the local JSON and confirmed hourly.',
      side_effects: 'Only the isolated local fixture changed. No production service or background job was started.',
      remaining: 'The intended agent should inspect the change and decide whether to keep or revert it.' })
    assert.equal(handoff.isError, false)
    const document = readFileSync(handoff.value, 'utf8')
    const handoffId = /Handoff: ([\w-]+)/.exec(document)[1]
    const index = await execute(agent, `evidence ${handoffId}`)
    assert.match(index, /tool\/result/); assert.ok(!index.includes('| mixed |'))
    assert.ok(document.length < 12000); assert.ok(!document.includes(longOutput)); assert.ok(!document.includes('UNRELATED-LOGIN-FOLLOWUP'))
    const cursor = index.split('\n').find(line => line.includes('tool/result')).match(/read_cursor: (\d+:0)/)[1]
    let next = cursor, combined = '', pages = 0
    do {
      const page = await execute(agent, `evidence ${handoffId} ${next}`)
      combined += page; pages++
      next = /next_cursor: ([^\n]+)/.exec(page)[1]
    } while (next.startsWith(cursor.split(':')[0] + ':'))
    assert.match(combined, /END-OF-SCOPED-EVIDENCE/); assert.ok(!combined.includes('UNRELATED-LOGIN-FOLLOWUP'))
    let allEvidence = '', evidenceCursor = '0:0'
    do {
      const page = await execute(agent, `evidence ${handoffId} ${evidenceCursor}`)
      allEvidence += page
      evidenceCursor = /next_cursor: ([^\n]+)/.exec(page)[1]
    } while (evidenceCursor !== '(end)')
    assert.ok(!allEvidence.includes('UNRELATED-LOGIN-FOLLOWUP'), 'all frozen evidence must exclude the later request')
    const stranger = await create()
    assert.equal((await tool(stranger.agent, 'conversation_guard_evidence', { handoff_id: handoffId })).isError, true)
    await stranger.dispose()
    record('5. Short handoff / 简短交接', document)
    record('6. Scoped evidence / 按需回查', `${index}\n\nVerified: ${longOutput.length} characters of tool output read in ${pages} pages; final marker retained.\nUnrelated later reply excluded. Cross-session evidence access rejected.\nMarkdown summary: ${document.length} characters; full tool output is not attached.`)
    await send(wrong)
    const retained = ctx.conversationGuard.pending(agent.session.id)
    await ctx.sessionPersistence.flush()
    writeFileSync(join(output, 'restart.json'), JSON.stringify({ sessionId: agent.session.id, handoffId, cursor, token: retained.token }))
    writeFileSync(join(output, 'handoff.md'), document)
    writeFileSync(join(output, 'demo.json'), JSON.stringify({ passed: true, workerCalls, evidencePages: pages, summaryCharacters: document.length, longOutputCharacters: longOutput.length, entries }, null, 2))
    await owned.dispose()
    console.log('DEMO_PASS')
  }
  const timeout = setTimeout(() => { console.error('DEMO_TIMEOUT'); process.exit(1) }, 45000)
  setTimeout(() => void run().then(() => { globalThis.fetch = originalFetch; clearTimeout(timeout); process.exit(0) }, error => {
    globalThis.fetch = originalFetch; clearTimeout(timeout); console.error('DEMO_FAIL', error.stack); process.exit(1)
  }), 100)
}
