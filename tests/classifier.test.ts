import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deepseekClassifier } from '../src/classifier.js'
const task = { sessionId: 's', objective: 'Fix login', revision: 1 }
const config = { apiKeyEnv: 'GUARD_TEST_FAKE_KEY', baseUrl: 'https://api.deepseek.com', model: 'test', timeoutMs: 1000 }
test('credential-free endpoint and strict verdict validation', async () => {
  assert.throws(() => deepseekClassifier({ ...config, baseUrl: 'http://host' }), /HTTPS/)
  assert.throws(() => deepseekClassifier({ ...config, baseUrl: 'https://secret@host' }), /credentials/)
  const saved = globalThis.fetch; process.env.GUARD_TEST_FAKE_KEY = 'synthetic'
  try {
    for (const content of ['{}', '{"kind":"allow"}', '{"kind":"suspected_misroute","reason":"bad","evidence":[]}']) {
      globalThis.fetch = async () => Response.json({ choices: [{ message: { content } }] })
      await assert.rejects(deepseekClassifier(config)(task, 'msg', [], new AbortController().signal))
    }
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.redirect, 'error')
      assert.equal(JSON.parse(String(options?.body)).response_format.type, 'json_object')
      return Response.json({ choices: [{ message: { content: '{"kind":"in_scope","reason":"relevant","evidence":[]}' } }] })
    }
    assert.equal((await deepseekClassifier(config)(task, 'msg', [], new AbortController().signal)).kind, 'in_scope')
  } finally { globalThis.fetch = saved; delete process.env.GUARD_TEST_FAKE_KEY }
})
