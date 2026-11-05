import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { EvidenceManifest, RequestBoundary } from './evidence.js'

export interface TaskProfile {
  sessionId: string
  objective: string
  directory?: string
  taskId?: string
  immutable?: boolean
  revision: number
}
export interface Envelope { id: string; source: { kind: string }; content: readonly unknown[] }
export interface Candidate { text: string; supported: boolean }
export interface Verdict {
  kind: 'in_scope' | 'explicit_switch' | 'suspected_misroute' | 'uncertain'
  reason: string
  evidence: string[]
}
export type Classifier = (task: TaskProfile, text: string, recent: string[], signal: AbortSignal) => Promise<Verdict>
export interface Batch {
  id: string
  sessionId: string
  token: string
  revision: number
  task?: TaskProfile
  digest: string
  messages: Envelope[]
  state: 'held' | 'ready' | 'admitted' | 'cancelled'
  reason: string
  verdict?: Verdict
  createdAt: string
  startSeq: number
  endSeq?: number
  approvedBy?: 'human' | 'classifier' | 'bootstrap'
}
export const textOf = (message: Envelope): Candidate => {
  const texts: string[] = []
  let supported = true
  for (const block of message.content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') texts.push(block.text)
    else supported = false
  }
  return { text: texts.join('\n'), supported }
}
const digest = (messages: Envelope[]) => createHash('sha256').update(JSON.stringify(messages)).digest('hex')

/** Durable host-side inbox. User messages are stored verbatim; classifier credentials are not stored. */
export class Journal {
  private db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (session TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (session TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, session TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_boundaries (session TEXT, seq INTEGER, value TEXT NOT NULL, PRIMARY KEY(session,seq));
      CREATE UNIQUE INDEX IF NOT EXISTS active_batch ON batches(session) WHERE state IN ('held','ready');`)
  }
  close() { this.db.close() }
  bindInput(session: string, id: string, candidate: Candidate | null) {
    const encoded = JSON.stringify(candidate)
    const row = this.db.prepare('SELECT value FROM inputs WHERE session=? AND id=?').get(session, id)
    if (row && row.value !== encoded) throw new Error('Managed input identity changed')
    this.db.prepare('INSERT OR IGNORE INTO inputs VALUES (?,?,?)').run(session, id, encoded)
  }
  input(session: string, id: string): Candidate | null | undefined {
    const row = this.db.prepare('SELECT value FROM inputs WHERE session=? AND id=?').get(session, id)
    return row ? JSON.parse(String(row.value)) as Candidate | null : undefined
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  task(session: string): TaskProfile | undefined {
    const row = this.db.prepare('SELECT value FROM tasks WHERE session=?').get(session)
    return row ? JSON.parse(String(row.value)) as TaskProfile : undefined
  }
  setTask(session: string, objective: string, details: Partial<Pick<TaskProfile, 'directory' | 'taskId' | 'immutable'>> = {}): TaskProfile {
    if (!objective.trim() || objective.length > 8000) throw new Error('Task must contain 1–8000 characters')
    return this.atomic(() => {
      if (this.active(session)) throw new Error('Resolve or cancel the pending batch before changing the task')
      const old = this.task(session)
      if (old?.immutable && (old.objective !== objective || old.taskId !== details.taskId)) throw new Error('Managed task scope is immutable')
      const task = { ...details, sessionId: session, objective, revision: (old?.revision ?? 0) + 1 }
      this.db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?)').run(session, JSON.stringify(task))
      return task
    })
  }
  get(session: string, id: string): Batch | undefined {
    const row = this.db.prepare('SELECT value FROM batches WHERE session=? AND id=?').get(session, id)
    return row ? JSON.parse(String(row.value)) as Batch : undefined
  }
  active(session: string): Batch | undefined {
    const row = this.db.prepare("SELECT value FROM batches WHERE session=? AND state IN ('held','ready')").get(session)
    return row ? JSON.parse(String(row.value)) as Batch : undefined
  }
  history(session: string): Batch[] {
    return this.db.prepare('SELECT value FROM batches WHERE session=? ORDER BY rowid').all(session).map(row => JSON.parse(String(row.value)) as Batch)
  }
  saveHandoff(manifest: EvidenceManifest) {
    this.db.prepare('INSERT INTO handoffs VALUES (?,?,?)').run(manifest.id, manifest.sessionId, JSON.stringify(manifest))
  }
  saveBoundary(session: string, boundary: RequestBoundary) {
    this.db.prepare('INSERT OR IGNORE INTO request_boundaries VALUES (?,?,?)').run(session, boundary.afterSeq, JSON.stringify(boundary))
  }
  boundaries(session: string): RequestBoundary[] {
    return this.db.prepare('SELECT value FROM request_boundaries WHERE session=? ORDER BY seq').all(session).map(row => JSON.parse(String(row.value)) as RequestBoundary)
  }
  handoff(session: string, id: string): EvidenceManifest | undefined {
    const row = this.db.prepare('SELECT value FROM handoffs WHERE session=? AND id=?').get(session, id)
    return row ? JSON.parse(String(row.value)) as EvidenceManifest : undefined
  }
  private write(batch: Batch) {
    this.db.prepare('INSERT OR REPLACE INTO batches VALUES (?,?,?,?)').run(batch.id, batch.sessionId, batch.state, JSON.stringify(batch))
  }
  park(session: string, messages: Envelope[], startSeq: number): Batch {
    return this.atomic(() => {
      const old = this.active(session)
      const known = new Map(old?.messages.map(message => [message.id, JSON.stringify(message)]) ?? [])
      const additions = messages.filter(message => {
        if (known.has(message.id) && known.get(message.id) !== JSON.stringify(message)) throw new Error('Message ID reused with different content')
        const fresh = !known.has(message.id); known.set(message.id, JSON.stringify(message)); return fresh
      })
      if (old && !additions.length) return old
      const all = [...old?.messages ?? [], ...additions]
      const batch: Batch = { id: old?.id ?? randomUUID(), sessionId: session, token: randomUUID(),
        revision: this.task(session)?.revision ?? 0, task: this.task(session), digest: digest(all), messages: all,
        state: 'held', reason: old ? 'New messages joined the held batch; review the complete batch again.' : 'Checking task intent',
        createdAt: old?.createdAt ?? new Date().toISOString(), startSeq: old?.startSeq ?? startSeq }
      this.write(batch)
      return batch
    })
  }
  update(session: string, token: string, changes: Partial<Pick<Batch, 'state' | 'reason' | 'verdict' | 'approvedBy' | 'endSeq'>>): Batch {
    return this.atomic(() => {
      const batch = this.active(session)
      if (!batch || batch.token !== token || batch.revision !== (this.task(session)?.revision ?? 0)
        || batch.digest !== digest(batch.messages)) throw new Error('Stale or invalid confirmation; use /guard status')
      Object.assign(batch, changes)
      this.write(batch)
      return batch
    })
  }
  /** Only committed user/message IDs count; a tool result or quoted JSON never admits a batch. */
  reconcile(session: string, committed: Set<string>, seq: number) {
    const batch = this.active(session)
    if (batch?.state === 'ready' && batch.messages.every(message => committed.has(message.id))) {
      this.update(session, batch.token, { state: 'admitted', endSeq: seq })
    }
  }
}

/** Uses the old task, never the candidate, as the semantic baseline. Failure is a durable hold. */
export async function inspectBatch(journal: Journal, batch: Batch, candidates: Candidate[], classifier: Classifier, signal: AbortSignal): Promise<Batch> {
  const settledByHuman = () => {
    const current = journal.get(batch.sessionId, batch.id)
    return current?.token === batch.token && current.approvedBy === 'human' ? current : undefined
  }
  const task = journal.task(batch.sessionId)
  if (!task) return journal.update(batch.sessionId, batch.token, { reason: 'Set a task with /guard task <objective> first.' })
  if (candidates.some(candidate => !candidate.supported || !candidate.text.trim() || candidate.text.length > 24000)) {
    return journal.update(batch.sessionId, batch.token, { reason: 'Attachment, empty text, or oversized input needs manual review.' })
  }
  try {
    const recent = journal.history(batch.sessionId).filter(item => item.state === 'admitted').slice(-4)
      .flatMap(item => item.messages.filter(message => message.source.kind === 'user').map(message => textOf(message).text.slice(0, 1200)))
    let last: Verdict = { kind: 'in_scope', reason: 'No human instruction in this batch', evidence: [] }
    for (const candidate of candidates) {
      signal.throwIfAborted()
      last = await classifier(task, candidate.text, recent, signal)
      if (last.kind !== 'in_scope') break
    }
    signal.throwIfAborted()
    const human = settledByHuman()
    if (human) return human
    return journal.update(batch.sessionId, batch.token, { state: last.kind === 'in_scope' ? 'ready' : 'held',
      verdict: last, reason: last.reason, ...(last.kind === 'in_scope' ? { approvedBy: 'classifier' as const } : {}) })
  } catch {
    const human = settledByHuman()
    if (human) return human
    // Provider response bodies/URLs may contain credentials; never persist or log them.
    return journal.update(batch.sessionId, batch.token, { state: 'held', reason: 'Intent check failed or was cancelled; message retained for manual review.' })
  }
}

export interface WorkerHandoff { summary: string; actions: string[]; artifacts: string[]; verification: string; sideEffects: string; remaining: string }
