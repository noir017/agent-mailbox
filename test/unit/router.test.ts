import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticate, DEFAULT_LIMITS, parseLimits, parseMailboxes, type MailboxEntry } from '../../src/config.js';
import { handle, type Deps } from '../../src/router.js';
import { MailboxStore } from '../../src/store.js';
import { memorySql } from './sqlite.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const TOKENS = {
  alphaAgent: 'mba_alpha-agent-token-0123456789',
  alphaClient: 'mbc_alpha-client-token-0123456789',
  betaAgent: 'mba_beta-agent-token-0123456789ab',
  betaClient: 'mbc_beta-client-token-0123456789ab',
};
const MAILBOXES = JSON.stringify({
  alpha: { agent: hash(TOKENS.alphaAgent), client: hash(TOKENS.alphaClient) },
  beta: { agent: hash(TOKENS.betaAgent), client: hash(TOKENS.betaClient) },
});

function relay(limits = DEFAULT_LIMITS) {
  const stores = new Map<string, MailboxStore>();
  const deps: Deps = {
    mailboxes: parseMailboxes(MAILBOXES),
    limits,
    open: (id) => {
      let s = stores.get(id);
      if (!s) stores.set(id, (s = new MailboxStore(memorySql(), limits)));
      return s;
    },
  };
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const init: RequestInit = { method, headers };
    if (opts.raw !== undefined) init.body = opts.raw;
    else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await handle(new Request(`https://relay.example.com${path}`, init), deps);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text, headers: res.headers };
  };
  return { call };
}

describe('routing and auth', () => {
  it('answers health without auth and 404 for anything unknown', async () => {
    const { call } = relay();
    expect((await call('GET', '/')).body).toEqual({ ok: true, service: 'agent-mailbox' });
    expect((await call('GET', '/agent/nothing', { token: TOKENS.alphaAgent })).status).toBe(404);
    expect((await call('GET', '/client/inbox', { token: TOKENS.alphaClient })).status).toBe(404);
    expect((await call('GET', '/elsewhere/ping')).status).toBe(404);
  });

  it('takes the agent token in the path or as a Bearer header', async () => {
    const { call } = relay();
    const viaHeader = await call('GET', '/agent/ping', { token: TOKENS.alphaAgent });
    const viaPath = await call('GET', `/agent${TOKENS.alphaAgent}/ping`);
    expect(viaHeader.body).toMatchObject({ ok: true, mailbox: 'alpha', role: 'agent' });
    expect(viaPath.body).toMatchObject({ ok: true, mailbox: 'alpha', role: 'agent' });
    expect(viaHeader.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the two roles apart', async () => {
    const { call } = relay();
    expect((await call('GET', '/agent/inbox', { token: TOKENS.alphaClient })).status).toBe(401);
    expect((await call('GET', `/agent${TOKENS.alphaClient}/inbox`)).status).toBe(401);
    expect((await call('GET', '/client/status', { token: TOKENS.alphaAgent })).status).toBe(401);
    // The client side has no path form.
    expect((await call('GET', `/client${TOKENS.alphaClient}/status`)).status).toBe(404);
    expect((await call('GET', '/client/status')).status).toBe(401);
    expect((await call('GET', '/agent/ping', { token: 'mba_not-a-real-token-at-all' })).status).toBe(401);
    expect((await call('GET', '/agent%2F..%2Fping')).status).toBe(404);
  });

  it('wants the right method', async () => {
    const { call } = relay();
    const r = await call('GET', '/client/send', { token: TOKENS.alphaClient });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });

  it('never echoes a token', async () => {
    const { call } = relay();
    for (const r of [
      await call('GET', `/agent${TOKENS.alphaClient}/ping`),
      await call('GET', '/agent/ping', { token: TOKENS.alphaAgent }),
      await call('POST', `/agent${TOKENS.alphaAgent}/reply`, { raw: 'not json' }),
    ]) {
      for (const t of Object.values(TOKENS)) expect(r.text).not.toContain(t);
    }
  });
});

describe('bodies', () => {
  it('caps the size, declared or streamed', async () => {
    const { call } = relay({ ...DEFAULT_LIMITS, maxBodyBytes: 64 });
    const big = { session: 's', text: 'x'.repeat(100) };
    expect((await call('POST', '/client/send', { token: TOKENS.alphaClient, body: big })).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"session":"s","text":"'));
        c.enqueue(new TextEncoder().encode('y'.repeat(100)));
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });
    const deps: Deps = {
      mailboxes: parseMailboxes(MAILBOXES),
      limits: { ...DEFAULT_LIMITS, maxBodyBytes: 64 },
      open: () => new MailboxStore(memorySql(), DEFAULT_LIMITS),
    };
    const req = new Request('https://relay.example.com/client/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKENS.alphaClient}` },
      body: streamed,
      duplex: 'half',
    } as RequestInit);
    expect((await handle(req, deps)).status).toBe(413);
  });

  it('wants a JSON object', async () => {
    const { call } = relay();
    expect((await call('POST', '/client/send', { token: TOKENS.alphaClient, raw: 'nope' })).status).toBe(400);
    expect((await call('POST', '/client/send', { token: TOKENS.alphaClient, raw: '[1]' })).status).toBe(400);
  });
});

describe('a round trip', () => {
  it('goes client → agent → client, and mailboxes do not see each other', async () => {
    const { call } = relay();
    const sent = await call('POST', '/client/send', {
      token: TOKENS.alphaClient,
      body: { session: 'chat-1', turn: 't1', type: 'message', text: '你好' },
    });
    expect(sent.body).toMatchObject({ ok: true, seq: 1, turn: 't1' });

    expect((await call('GET', '/agent/inbox', { token: TOKENS.betaAgent })).body.messages).toEqual([]);
    const inbox = await call('GET', `/agent${TOKENS.alphaAgent}/inbox`);
    expect(inbox.body.messages).toMatchObject([{ seq: 1, session: 'chat-1', turn: 't1', type: 'message', text: '你好' }]);

    const reply = await call('POST', '/agent/reply', {
      token: TOKENS.alphaAgent,
      body: { session: 'chat-1', turn: 't1', type: 'final', text: '在的' },
    });
    expect(reply.body).toMatchObject({ ok: true, seq: 1 });
    // beta's client cannot reply into alpha's session, nor read it.
    expect(
      (await call('POST', '/agent/reply', { token: TOKENS.betaAgent, body: { session: 'chat-1', turn: 't1', type: 'final', text: 'x' } }))
        .status,
    ).toBe(404);
    expect((await call('GET', '/client/replies?session=chat-1', { token: TOKENS.betaClient })).body.replies).toEqual([]);

    const got = await call('GET', '/client/replies?session=chat-1', { token: TOKENS.alphaClient });
    expect(got.body.replies).toMatchObject([{ seq: 1, session: 'chat-1', turn: 't1', type: 'final', text: '在的' }]);
    expect(got.body.agent).toMatchObject({ fetched_upto: 1 });
    expect((await call('GET', '/client/replies?session=chat-1&after=1', { token: TOKENS.alphaClient })).body.replies).toEqual([]);
  });
});

describe('config', () => {
  it('rejects malformed MAILBOXES loudly', () => {
    expect(parseMailboxes(undefined)).toEqual([]);
    expect(() => parseMailboxes('{')).toThrow(/not valid JSON/);
    expect(() => parseMailboxes('[]')).toThrow(/object/);
    expect(() => parseMailboxes(JSON.stringify({ 'Bad Id': { agent: hash('a'), client: hash('b') } }))).toThrow(/invalid mailbox id/);
    expect(() => parseMailboxes(JSON.stringify({ a: { agent: 'nothex', client: hash('b') } }))).toThrow(/sha256/);
    expect(() => parseMailboxes(JSON.stringify({ a: { agent: hash('x'), client: hash('x') } }))).toThrow(/one token/);
    expect(() =>
      parseMailboxes(JSON.stringify({ a: { agent: hash('x'), client: hash('y') }, b: { agent: hash('x'), client: hash('z') } })),
    ).toThrow(/twice/);
  });

  it('reads limits with defaults', () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    expect(parseLimits({ TTL_HOURS: '1', MAX_PENDING: '5' })).toMatchObject({ ttlMs: 3_600_000, maxPending: 5 });
    expect(() => parseLimits({ MAX_BODY_BYTES: '0' })).toThrow(/positive/);
  });

  it('authenticates only well-formed tokens of the right role', async () => {
    const boxes: MailboxEntry[] = parseMailboxes(MAILBOXES);
    expect((await authenticate(boxes, 'agent', TOKENS.betaAgent))?.id).toBe('beta');
    expect(await authenticate(boxes, 'client', TOKENS.betaAgent)).toBeUndefined();
    expect(await authenticate(boxes, 'agent', 'hsurr:placeholder')).toBeUndefined();
    expect(await authenticate(boxes, 'agent', undefined)).toBeUndefined();
  });
});
