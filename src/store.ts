/**
 * One mailbox: what the client delivered for the agent, and what the agent replied.
 *
 * Runs inside the mailbox's Durable Object over its SQLite storage, and in the unit tests over
 * node:sqlite — hence the tiny `Sql` interface instead of the Workers API. Every method is
 * synchronous: Durable Object SQL is, and a single-threaded object needs no locking.
 *
 * Two directions, two cursors:
 * - inbox (client → agent): `message` and `cancel`. The agent polls `inbox(after)`; passing the
 *   cursor it got last time confirms everything up to it, which is deleted.
 * - replies (agent → client): `progress`, `final`, `message`. The client polls `replies(session,
 *   after)` the same way, per session.
 *
 * Sequence numbers are per direction, per mailbox, and never reused (a counter in `meta`), so a
 * cursor cannot skip a message written after a delete.
 *
 * Cost on the Workers Free plan is rows read/written per day (see README). An empty poll reads a
 * row or two and writes nothing; the agent's last poll time lives in memory and reaches storage
 * at most once a minute (`POLL_PERSIST_MS`).
 */
import type { Limits } from './config.js';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** The slice of an SQLite API the store needs. */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): Row[];
}

/** What every method returns: an HTTP status and a JSON body, plain data so it crosses RPC. */
export interface Result {
  status: number;
  body: Record<string, unknown>;
}

export type InboxType = 'message' | 'cancel';
export type ReplyType = 'progress' | 'final' | 'message';

export interface InboxMessage {
  seq: number;
  session: string;
  turn: string;
  type: InboxType;
  text: string;
  at: number;
}

export interface Reply {
  seq: number;
  session: string;
  turn: string | null;
  type: ReplyType;
  text: string;
  at: number;
}

/** How often the in-memory last-poll time is written down. */
export const POLL_PERSIST_MS = 60_000;
/** How often expired rows are swept. */
const SWEEP_MS = 3_600_000;
/** Most rows one poll returns. */
export const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TURN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, turn TEXT NOT NULL,
     type TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS replies (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, turn TEXT,
     type TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS replies_by_session ON replies (session, seq)',
  'CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, at INTEGER NOT NULL)',
];

const ok = (body: Record<string, unknown>): Result => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string): Result => ({ status, body: { ok: false, error } });

export class MailboxStore {
  private lastPollAt: number | null;
  private persistedPollAt: number | null;
  private lastSweep = 0;

  constructor(
    private readonly sql: Sql,
    private readonly limits: Limits,
    private readonly now: () => number = Date.now,
  ) {
    for (const statement of SCHEMA) this.sql.exec(statement);
    this.lastPollAt = this.meta('last_poll_at') || null;
    this.persistedPollAt = this.lastPollAt;
  }

  // ───────────────────────────── agent side ─────────────────────────────

  /**
   * Messages after `after`, oldest first. `after` confirms everything up to it.
   *
   * A cursor beyond the newest message ever written is treated as no cursor: the agent kept one
   * across a storage reset, and honouring it would delete and skip the messages written since.
   */
  inbox(afterRaw: unknown, limitRaw: unknown): Result {
    const now = this.now();
    this.sweep(now);
    const limit = parseLimit(limitRaw);
    let after = parseCursor(afterRaw);
    if (after === 'bad' || limit === 'bad') return fail(400, 'after and limit must be non-negative integers');
    if (after !== undefined && after > this.meta('inbox_seq')) after = undefined;
    if (after !== undefined) {
      this.sql.exec('DELETE FROM inbox WHERE seq <= ?', after);
      if (after > this.meta('acked_upto')) this.setMeta('acked_upto', after);
    }
    const rows = this.sql.exec(
      'SELECT seq, session, turn, type, text, at FROM inbox WHERE seq > ? AND at > ? ORDER BY seq LIMIT ?',
      after ?? 0,
      now - this.limits.ttlMs,
      limit,
    ) as unknown as InboxMessage[];
    const last = rows.at(-1)?.seq;
    if (last !== undefined && last > this.meta('fetched_upto')) this.setMeta('fetched_upto', last);
    this.notePoll(now);
    return ok({ messages: rows, cursor: last ?? after ?? this.meta('acked_upto') });
  }

  /** The agent's answer, progress note or unprompted message for a session. */
  reply(body: unknown): Result {
    const now = this.now();
    this.sweep(now);
    const b = body as Record<string, unknown> | null;
    const session = b?.session;
    const type = b?.type;
    const turn = b?.turn ?? null;
    const text = b?.text;
    if (typeof session !== 'string' || !SESSION.test(session)) return fail(400, 'session is missing or malformed');
    if (type !== 'progress' && type !== 'final' && type !== 'message') {
      return fail(400, 'type must be progress, final or message');
    }
    if (turn !== null && (typeof turn !== 'string' || !TURN.test(turn))) return fail(400, 'turn is malformed');
    if (turn === null && type !== 'message') return fail(400, `a ${type} needs the turn it belongs to`);
    if (typeof text !== 'string' || text.length === 0) return fail(400, 'text is missing');
    if (text.length > this.limits.maxTextChars) return fail(413, `text is over ${this.limits.maxTextChars} characters`);
    // A reply to a session the client never opened (or one expired) has nobody to read it.
    if (this.sql.exec('SELECT 1 AS x FROM sessions WHERE session = ?', session).length === 0) {
      return fail(404, 'unknown session');
    }
    if (this.count('replies') >= this.limits.maxPending) return fail(429, 'too many unread replies in this mailbox');
    const seq = this.next('reply_seq');
    this.sql.exec(
      'INSERT INTO replies (seq, session, turn, type, text, at) VALUES (?, ?, ?, ?, ?, ?)',
      seq,
      session,
      turn,
      type,
      text,
      now,
    );
    this.touchSession(session, now);
    return ok({ seq });
  }

  /** A harmless read for setup checks. Not counted as a poll. */
  ping(mailbox: string): Result {
    const pending = this.sql.exec('SELECT COUNT(*) AS n FROM inbox WHERE at > ?', this.now() - this.limits.ttlMs)[0]?.n;
    return ok({ mailbox, role: 'agent', pending: Number(pending ?? 0) });
  }

  // ───────────────────────────── client side ─────────────────────────────

  /** Deliver a message (or a raw cancel) for the agent. */
  send(body: unknown): Result {
    const now = this.now();
    this.sweep(now);
    const b = body as Record<string, unknown> | null;
    const session = b?.session;
    const type = b?.type ?? 'message';
    const text = b?.text ?? '';
    if (typeof session !== 'string' || !SESSION.test(session)) return fail(400, 'session is missing or malformed');
    if (type !== 'message' && type !== 'cancel') return fail(400, 'type must be message or cancel');
    if (typeof text !== 'string') return fail(400, 'text must be a string');
    if (type === 'message' && text.length === 0) return fail(400, 'text is missing');
    if (text.length > this.limits.maxTextChars) return fail(413, `text is over ${this.limits.maxTextChars} characters`);
    let turn = b?.turn;
    if (turn === undefined && type === 'cancel') return fail(400, 'a cancel needs the turn it cancels');
    if (turn !== undefined && (typeof turn !== 'string' || !TURN.test(turn))) return fail(400, 'turn is malformed');
    if (type === 'message' && turn !== undefined) {
      // A client that lost the answer sends again with the same turn: file it under the first copy
      // rather than hand the agent the same message twice.
      const first = this.sql.exec("SELECT seq FROM inbox WHERE session = ? AND turn = ? AND type = 'message'", session, turn as string)[0];
      if (first) return ok({ seq: Number(first.seq), turn, duplicate: true, agent: this.agentStatus() });
    }
    if (this.count('inbox') >= this.limits.maxPending) return fail(429, 'too many undelivered messages in this mailbox');
    const seq = this.next('inbox_seq');
    turn ??= String(seq);
    this.sql.exec(
      'INSERT INTO inbox (seq, session, turn, type, text, at) VALUES (?, ?, ?, ?, ?, ?)',
      seq,
      session,
      turn as string,
      type,
      text,
      now,
    );
    this.touchSession(session, now);
    return ok({ seq, turn, agent: this.agentStatus() });
  }

  /**
   * Replies after `after`, oldest first, for one session or (no session) all of them. `after`
   * confirms everything up to it in that scope. The agent's polling status rides along, so a
   * client waiting for its message to be picked up needs no second request.
   */
  replies(sessionRaw: unknown, afterRaw: unknown, limitRaw: unknown): Result {
    const now = this.now();
    this.sweep(now);
    const limit = parseLimit(limitRaw);
    let after = parseCursor(afterRaw);
    if (after === 'bad' || limit === 'bad') return fail(400, 'after and limit must be non-negative integers');
    const session = sessionRaw === undefined || sessionRaw === null || sessionRaw === '' ? undefined : sessionRaw;
    if (session !== undefined && (typeof session !== 'string' || !SESSION.test(session))) {
      return fail(400, 'session is malformed');
    }
    if (after !== undefined && after > this.meta('reply_seq')) after = undefined;
    const scope = session === undefined ? '' : ' AND session = ?';
    const scopeArgs: SqlValue[] = session === undefined ? [] : [session as string];
    if (after !== undefined) this.sql.exec(`DELETE FROM replies WHERE seq <= ?${scope}`, after, ...scopeArgs);
    const rows = this.sql.exec(
      `SELECT seq, session, turn, type, text, at FROM replies WHERE seq > ?${scope} AND at > ? ORDER BY seq LIMIT ?`,
      after ?? 0,
      ...scopeArgs,
      now - this.limits.ttlMs,
      limit,
    ) as unknown as Reply[];
    return ok({ replies: rows, cursor: rows.at(-1)?.seq ?? after ?? 0, agent: this.agentStatus() });
  }

  /**
   * Cancel a turn. A message the agent has not fetched yet is withdrawn — the agent never sees
   * the turn. Otherwise a `cancel` is queued for it, unless `withdraw_only` asks for nothing
   * but the withdrawal (a client giving up on a pickup must not tell the agent to stop work it
   * may just have started).
   */
  cancel(body: unknown): Result {
    const b = body as Record<string, unknown> | null;
    const session = b?.session;
    const turn = b?.turn;
    if (typeof session !== 'string' || !SESSION.test(session)) return fail(400, 'session is missing or malformed');
    if (typeof turn !== 'string' || !TURN.test(turn)) return fail(400, 'turn is missing or malformed');
    const fetched = this.meta('fetched_upto');
    const unfetched = this.sql.exec(
      "SELECT seq FROM inbox WHERE session = ? AND turn = ? AND type = 'message' AND seq > ?",
      session,
      turn,
      fetched,
    );
    if (unfetched.length > 0) {
      this.sql.exec(
        "DELETE FROM inbox WHERE session = ? AND turn = ? AND type = 'message' AND seq > ?",
        session,
        turn,
        fetched,
      );
      return ok({ withdrawn: unfetched.length, agent: this.agentStatus() });
    }
    if (b?.withdraw_only === true) return ok({ withdrawn: 0, agent: this.agentStatus() });
    const queued = this.send({ session, turn, type: 'cancel', text: typeof b?.text === 'string' ? b.text : '' });
    if (queued.status !== 200) return queued;
    return ok({ withdrawn: 0, seq: queued.body.seq, agent: this.agentStatus() });
  }

  status(mailbox: string): Result {
    return ok({ mailbox, role: 'client', agent: this.agentStatus() });
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** What a client needs to tell "not picked up yet" from "the agent is gone". */
  private agentStatus(): Record<string, number | null> {
    return {
      last_poll_at: this.lastPollAt,
      fetched_upto: this.meta('fetched_upto'),
      acked_upto: this.meta('acked_upto'),
    };
  }

  private notePoll(now: number): void {
    this.lastPollAt = now;
    if (this.persistedPollAt === null || now - this.persistedPollAt >= POLL_PERSIST_MS) {
      this.setMeta('last_poll_at', now);
      this.persistedPollAt = now;
    }
  }

  private touchSession(session: string, now: number): void {
    this.sql.exec(
      'INSERT INTO sessions (session, at) VALUES (?, ?) ON CONFLICT (session) DO UPDATE SET at = excluded.at',
      session,
      now,
    );
  }

  /** Drop expired rows, at most once an hour per object. */
  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    const cutoff = now - this.limits.ttlMs;
    this.sql.exec('DELETE FROM inbox WHERE at <= ?', cutoff);
    this.sql.exec('DELETE FROM replies WHERE at <= ?', cutoff);
    this.sql.exec('DELETE FROM sessions WHERE at <= ?', cutoff);
  }

  private count(table: 'inbox' | 'replies'): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0);
  }

  private meta(key: string): number {
    return Number(this.sql.exec('SELECT v FROM meta WHERE k = ?', key)[0]?.v ?? 0);
  }

  private setMeta(key: string, value: number): void {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, value);
  }

  private next(key: 'inbox_seq' | 'reply_seq'): number {
    const value = this.meta(key) + 1;
    this.setMeta(key, value);
    return value;
  }
}

function parseCursor(raw: unknown): number | undefined | 'bad' {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 'bad';
}

function parseLimit(raw: unknown): number | 'bad' {
  const n = parseCursor(raw);
  if (n === 'bad') return 'bad';
  if (n === undefined || n === 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
