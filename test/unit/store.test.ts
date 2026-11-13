import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, type Limits } from '../../src/config.js';
import { MailboxStore, POLL_PERSIST_MS, type InboxMessage, type Reply } from '../../src/store.js';
import { memorySql } from './sqlite.js';

function setup(limits: Partial<Limits> = {}) {
  let now = 1_000_000;
  const sql = memorySql();
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const store = new MailboxStore(sql, { ...DEFAULT_LIMITS, ...limits }, clock.now);
  return { store, sql, clock };
}

const messages = (r: { body: Record<string, unknown> }) => r.body.messages as InboxMessage[];
const replies = (r: { body: Record<string, unknown> }) => r.body.replies as Reply[];

describe('inbox', () => {
  it('delivers in order and deletes what the next cursor confirms', () => {
    const { store } = setup();
    expect(store.send({ session: 's1', turn: 't1', type: 'message', text: 'hello' }).body).toMatchObject({ seq: 1, turn: 't1' });
    store.send({ session: 's2', type: 'message', text: 'second' });
    const first = store.inbox(undefined, undefined);
    expect(messages(first).map((m) => [m.seq, m.session, m.turn, m.type, m.text])).toEqual([
      [1, 's1', 't1', 'message', 'hello'],
      [2, 's2', '2', 'message', 'second'],
    ]);
    expect(first.body.cursor).toBe(2);
    // Same cursor again: nothing new, and both are now confirmed.
    const again = store.inbox(2, undefined);
    expect(messages(again)).toEqual([]);
    expect(again.body.cursor).toBe(2);
    expect(store.ping('mb').body.pending).toBe(0);
  });

  it('never reuses a sequence number after everything was deleted', () => {
    const { store } = setup();
    store.send({ session: 's', type: 'message', text: 'a' });
    store.inbox(undefined, undefined);
    store.inbox(1, undefined);
    expect(store.send({ session: 's', type: 'message', text: 'b' }).body.seq).toBe(2);
    expect(messages(store.inbox(1, undefined)).map((m) => m.seq)).toEqual([2]);
  });

  it('ignores a cursor from beyond the newest message instead of skipping new ones', () => {
    const { store } = setup();
    store.send({ session: 's', type: 'message', text: 'after a reset' });
    const r = store.inbox(57, undefined);
    expect(messages(r).map((m) => m.text)).toEqual(['after a reset']);
    expect(r.body.cursor).toBe(1);
  });

  it('caps the page size and rejects bad cursors', () => {
    const { store } = setup();
    for (let i = 0; i < 120; i++) store.send({ session: 's', type: 'message', text: `m${i}` });
    expect(messages(store.inbox(undefined, 500))).toHaveLength(100);
    expect(messages(store.inbox(undefined, 3))).toHaveLength(3);
    expect(store.inbox('-1', undefined).status).toBe(400);
    expect(store.inbox('x', undefined).status).toBe(400);
  });

  it('records when the agent last came and how far it fetched', () => {
    const { store, clock } = setup();
    expect(store.status('mb').body.agent).toEqual({ last_poll_at: null, fetched_upto: 0, acked_upto: 0 });
    store.send({ session: 's', type: 'message', text: 'x' });
    store.inbox(undefined, undefined);
    clock.advance(5_000);
    store.inbox(1, undefined);
    expect(store.status('mb').body.agent).toEqual({ last_poll_at: 1_005_000, fetched_upto: 1, acked_upto: 1 });
  });

  it('an empty poll writes nothing to storage once the poll time is fresh', () => {
    const { store, sql, clock } = setup();
    store.inbox(undefined, undefined); // first poll ever: the time is written once
    const before = sql.written;
    for (let i = 0; i < 11; i++) {
      clock.advance(5_000);
      store.inbox(0, undefined);
    }
    expect(sql.written).toBe(before);
    clock.advance(POLL_PERSIST_MS);
    store.inbox(0, undefined);
    expect(sql.written).toBe(before + 1);
  });

  it('a fresh object over the same storage reports the last persisted poll', () => {
    const { store, sql, clock } = setup();
    store.inbox(undefined, undefined);
    clock.advance(10_000);
    store.inbox(0, undefined); // in memory only
    const reopened = new MailboxStore(sql, DEFAULT_LIMITS, clock.now);
    expect(reopened.status('mb').body.agent).toMatchObject({ last_poll_at: 1_000_000 });
  });
});

describe('send', () => {
  it('validates what it is given', () => {
    const { store } = setup({ maxTextChars: 5 });
    expect(store.send({ type: 'message', text: 'x' }).status).toBe(400);
    expect(store.send({ session: 'bad session', text: 'x' }).status).toBe(400);
    expect(store.send({ session: 's', type: 'progress', text: 'x' }).status).toBe(400);
    expect(store.send({ session: 's', type: 'message', text: '' }).status).toBe(400);
    expect(store.send({ session: 's', type: 'message', text: 'too long' }).status).toBe(413);
    expect(store.send({ session: 's', type: 'cancel' }).status).toBe(400); // a cancel names its turn
    expect(store.send({ session: 's', turn: 'a/b', text: 'x' }).status).toBe(400);
  });

  it('files a repeated message of the same turn under the first copy', () => {
    const { store } = setup();
    expect(store.send({ session: 's', turn: 't1', text: 'hello' }).body).toMatchObject({ seq: 1 });
    expect(store.send({ session: 's', turn: 't1', text: 'hello' }).body).toMatchObject({ seq: 1, duplicate: true });
    expect(store.send({ session: 's', turn: 't2', text: 'hello' }).body).toMatchObject({ seq: 2 });
    expect(messages(store.inbox(undefined, undefined))).toHaveLength(2);
  });

  it('refuses more than maxPending undelivered messages', () => {
    const { store } = setup({ maxPending: 2 });
    store.send({ session: 's', text: 'a' });
    store.send({ session: 's', text: 'b' });
    expect(store.send({ session: 's', text: 'c' }).status).toBe(429);
  });
});

describe('replies', () => {
  it('needs a session the client opened and a turn for progress and final', () => {
    const { store } = setup();
    expect(store.reply({ session: 'nobody', type: 'final', turn: 't', text: 'x' }).status).toBe(404);
    store.send({ session: 's', turn: 't', text: 'q' });
    expect(store.reply({ session: 's', type: 'final', text: 'x' }).status).toBe(400);
    expect(store.reply({ session: 's', type: 'progress', text: 'x' }).status).toBe(400);
    expect(store.reply({ session: 's', type: 'other', turn: 't', text: 'x' }).status).toBe(400);
    expect(store.reply({ session: 's', type: 'final', turn: 't', text: '' }).status).toBe(400);
    expect(store.reply({ session: 's', type: 'message', text: 'unprompted' }).status).toBe(200);
  });

  it('are read and confirmed per session', () => {
    const { store } = setup();
    store.send({ session: 'a', turn: '1', text: 'qa' });
    store.send({ session: 'b', turn: '1', text: 'qb' });
    store.reply({ session: 'a', turn: '1', type: 'progress', text: 'working' });
    store.reply({ session: 'b', turn: '1', type: 'final', text: 'B done' });
    store.reply({ session: 'a', turn: '1', type: 'final', text: 'A done' });

    const a = store.replies('a', undefined, undefined);
    expect(replies(a).map((r) => [r.seq, r.type, r.text])).toEqual([
      [1, 'progress', 'working'],
      [3, 'final', 'A done'],
    ]);
    expect(a.body.cursor).toBe(3);
    // Confirming a's cursor leaves b's reply alone, even though its seq is lower.
    expect(replies(store.replies('a', 3, undefined))).toEqual([]);
    expect(replies(store.replies('b', undefined, undefined)).map((r) => r.text)).toEqual(['B done']);
    // No session: the whole mailbox.
    expect(replies(store.replies(undefined, undefined, undefined)).map((r) => r.seq)).toEqual([2]);
  });

  it('carry the turn, or null for an unprompted message', () => {
    const { store } = setup();
    store.send({ session: 's', turn: 't9', text: 'q' });
    store.reply({ session: 's', type: 'message', text: 'later' });
    store.reply({ session: 's', turn: 't9', type: 'message', text: 'part' });
    expect(replies(store.replies('s', undefined, undefined)).map((r) => r.turn)).toEqual([null, 't9']);
  });

  it('carry the agent status', () => {
    const { store } = setup();
    store.send({ session: 's', turn: 't', text: 'q' });
    expect(store.replies('s', undefined, undefined).body.agent).toMatchObject({ fetched_upto: 0, last_poll_at: null });
    store.inbox(undefined, undefined);
    expect(store.replies('s', undefined, undefined).body.agent).toMatchObject({ fetched_upto: 1, last_poll_at: 1_000_000 });
  });
});

describe('cancel', () => {
  it('withdraws a message the agent has not fetched', () => {
    const { store } = setup();
    store.send({ session: 's', turn: 't', text: 'never mind' });
    expect(store.cancel({ session: 's', turn: 't' }).body).toMatchObject({ withdrawn: 1 });
    expect(messages(store.inbox(undefined, undefined))).toEqual([]);
  });

  it('queues a cancel once the agent has the message', () => {
    const { store } = setup();
    store.send({ session: 's', turn: 't', text: 'long job' });
    store.inbox(undefined, undefined);
    const r = store.cancel({ session: 's', turn: 't' });
    expect(r.body).toMatchObject({ withdrawn: 0, seq: 2 });
    expect(messages(store.inbox(1, undefined)).map((m) => [m.type, m.turn])).toEqual([['cancel', 't']]);
  });

  it('withdraw_only never queues a cancel', () => {
    const { store } = setup();
    store.send({ session: 's', turn: 't', text: 'job' });
    store.inbox(undefined, undefined);
    expect(store.cancel({ session: 's', turn: 't', withdraw_only: true }).body).toMatchObject({ withdrawn: 0 });
    expect(messages(store.inbox(1, undefined))).toEqual([]);
  });
});

describe('expiry', () => {
  it('hides and then sweeps what is older than the TTL', () => {
    const { store, sql, clock } = setup({ ttlMs: 60_000 });
    store.send({ session: 's', turn: 't', text: 'old' });
    store.reply({ session: 's', turn: 't', type: 'final', text: 'old reply' });
    clock.advance(61_000);
    expect(messages(store.inbox(undefined, undefined))).toEqual([]);
    expect(replies(store.replies('s', undefined, undefined))).toEqual([]);
    clock.advance(3_600_000); // the hourly sweep
    store.inbox(undefined, undefined);
    const left = (t: string) => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t}`)[0]?.n);
    expect([left('inbox'), left('replies'), left('sessions')]).toEqual([0, 0, 0]);
    // The session is gone with it: a reply to it has nobody to read it.
    expect(store.reply({ session: 's', turn: 't', type: 'final', text: 'late' }).status).toBe(404);
  });
});
