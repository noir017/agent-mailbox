/**
 * HTTP surface of the relay. Pure: no Cloudflare imports, so the unit tests drive it directly with
 * an in-process mailbox.
 *
 * Agent side (the polling cloud agent):
 *   GET  /agent<token>/ping | /agent/ping      Authorization: Bearer <token>
 *   GET  /agent<token>/inbox?after=&limit=
 *   POST /agent<token>/reply                   {session, turn?, type, text}
 *
 * The token may sit in the first path segment, right after `agent` — the shape of Telegram's
 * `/bot<token>/` — or in an Authorization header. Some agent platforms can place a credential in
 * only one of the two, so both open the same routes.
 *
 * Client side (the gateway), Bearer only:
 *   POST /client/send      {session, turn?, type: message|cancel, text}
 *   GET  /client/replies?session=&after=&limit=
 *   POST /client/cancel    {session, turn, withdraw_only?}
 *   GET  /client/status
 *
 * Nothing here logs a URL, a header or a body: a path token would land in the log with them.
 */
import { authenticate, type Limits, type MailboxEntry, type Role } from './config.js';
import type { Result } from './store.js';

export interface MailboxApi {
  inbox(after: unknown, limit: unknown): Promise<Result> | Result;
  reply(body: unknown): Promise<Result> | Result;
  ping(mailbox: string): Promise<Result> | Result;
  send(body: unknown): Promise<Result> | Result;
  replies(session: unknown, after: unknown, limit: unknown): Promise<Result> | Result;
  cancel(body: unknown): Promise<Result> | Result;
  status(mailbox: string): Promise<Result> | Result;
}

export interface Deps {
  mailboxes: readonly MailboxEntry[];
  limits: Limits;
  /** The mailbox object for an id (a Durable Object stub in production). */
  open(id: string): MailboxApi;
  log?: (line: string) => void;
}

type Op = { method: 'GET' | 'POST'; run: (m: MailboxApi, ctx: OpContext) => Promise<Result> | Result };
interface OpContext {
  mailbox: string;
  query: URLSearchParams;
  body: unknown;
}

const AGENT_OPS: Record<string, Op> = {
  ping: { method: 'GET', run: (m, c) => m.ping(c.mailbox) },
  inbox: { method: 'GET', run: (m, c) => m.inbox(c.query.get('after') ?? undefined, c.query.get('limit') ?? undefined) },
  reply: { method: 'POST', run: (m, c) => m.reply(c.body) },
};

const CLIENT_OPS: Record<string, Op> = {
  send: { method: 'POST', run: (m, c) => m.send(c.body) },
  replies: {
    method: 'GET',
    run: (m, c) =>
      m.replies(c.query.get('session') ?? undefined, c.query.get('after') ?? undefined, c.query.get('limit') ?? undefined),
  },
  cancel: { method: 'POST', run: (m, c) => m.cancel(c.body) },
  status: { method: 'GET', run: (m, c) => m.status(c.mailbox) },
};

export function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

const error = (status: number, message: string, headers?: Record<string, string>): Response =>
  json(status, { ok: false, error: message }, headers);

interface Route {
  role: Role;
  op: Op;
  /** The token from the path, when the agent put it there. */
  pathToken?: string;
}

function route(pathname: string): Route | undefined {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts.length !== 2) return undefined;
  const [head, name] = parts as [string, string];
  if (head === 'client') {
    const op = CLIENT_OPS[name];
    return op ? { role: 'client', op } : undefined;
  }
  if (head.startsWith('agent')) {
    const op = AGENT_OPS[name];
    if (!op) return undefined;
    // `/agent/<op>` takes the header; `/agent<token>/<op>` carries the token itself. The token is
    // used exactly as sent — the agent platform swaps its placeholder for it on the way out, and
    // a percent-encoded placeholder would not have been swapped (see the Muse connector notes).
    return head === 'agent' ? { role: 'agent', op } : { role: 'agent', op, pathToken: head.slice('agent'.length) };
  }
  return undefined;
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

/** Read at most `max` bytes of the body; undefined when it is longer. */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/' || url.pathname === '/health') {
    return json(200, { ok: true, service: 'agent-mailbox' });
  }
  const r = route(url.pathname);
  if (!r) return error(404, 'not found');
  if (request.method !== r.op.method) return error(405, 'method not allowed', { allow: r.op.method });

  const token = r.pathToken ?? bearer(request);
  const mailbox = await authenticate(deps.mailboxes, r.role, token);
  if (!mailbox) return error(401, 'unauthorized', r.role === 'client' ? { 'www-authenticate': 'Bearer' } : {});

  let body: unknown;
  if (r.op.method === 'POST') {
    const raw = await readCapped(request, deps.limits.maxBodyBytes);
    if (raw === undefined) return error(413, `request body is over ${deps.limits.maxBodyBytes} bytes`);
    try {
      body = JSON.parse(raw);
    } catch {
      return error(400, 'request body is not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'request body must be a JSON object');
  }

  const result = await r.op.run(deps.open(mailbox.id), { mailbox: mailbox.id, query: url.searchParams, body });
  return json(result.status, result.body);
}
