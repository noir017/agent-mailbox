/**
 * Worker entry: one Durable Object per mailbox, the HTTP surface in router.ts.
 *
 * Why a Durable Object per mailbox rather than D1: sequence numbers and "picked up yet" need one
 * writer per mailbox, and the agent's last poll time can then live in memory instead of costing a
 * row write on every poll (see store.ts). The free plan only offers SQLite-backed objects, which is
 * what `new_sqlite_classes` in wrangler.jsonc creates.
 *
 * Short polling only. An object is billed for duration while a request is in flight; a held long
 * poll would bill it around the clock (README, "Free plan").
 */
import { DurableObject } from 'cloudflare:workers';
import { parseLimits, parseMailboxes, type Env as ConfigEnv, type Limits, type MailboxEntry } from './config.js';
import { handle, json, type MailboxApi } from './router.js';
import { MailboxStore, type Result, type Sql, type SqlValue } from './store.js';

export interface Env extends ConfigEnv {
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

export class Mailbox extends DurableObject<Env> implements MailboxApi {
  private readonly store: MailboxStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: Sql = {
      exec: (query: string, ...params: SqlValue[]) =>
        ctx.storage.sql.exec(query, ...params).toArray() as Record<string, SqlValue>[],
    };
    this.store = new MailboxStore(sql, parseLimits(env));
  }

  inbox(after: unknown, limit: unknown): Result {
    return this.store.inbox(after, limit);
  }
  reply(body: unknown): Result {
    return this.store.reply(body);
  }
  ping(mailbox: string): Result {
    return this.store.ping(mailbox);
  }
  send(body: unknown): Result {
    return this.store.send(body);
  }
  replies(session: unknown, after: unknown, limit: unknown): Result {
    return this.store.replies(session, after, limit);
  }
  cancel(body: unknown): Result {
    return this.store.cancel(body);
  }
  status(mailbox: string): Result {
    return this.store.status(mailbox);
  }
}

/** Parsed settings, kept per isolate and redone only when the secret's text changes. */
let cached: { raw: string | undefined; mailboxes: MailboxEntry[]; limits: Limits; env: Env } | undefined;

function settings(env: Env): { mailboxes: MailboxEntry[]; limits: Limits } {
  if (!cached || cached.raw !== env.MAILBOXES || cached.env !== env) {
    cached = { raw: env.MAILBOXES, mailboxes: parseMailboxes(env.MAILBOXES), limits: parseLimits(env), env };
  }
  return cached;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let config: { mailboxes: MailboxEntry[]; limits: Limits };
    try {
      config = settings(env);
    } catch (err) {
      // The message names the setting, never its value.
      console.error(`agent-mailbox: bad configuration: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { ok: false, error: 'relay is misconfigured' });
    }
    try {
      return await handle(request, {
        ...config,
        open: (id) => env.MAILBOX.get(env.MAILBOX.idFromName(id)) as unknown as MailboxApi,
      });
    } catch (err) {
      console.error(`agent-mailbox: request failed: ${err instanceof Error ? err.message : String(err)}`);
      return json(500, { ok: false, error: 'internal error' });
    }
  },
} satisfies ExportedHandler<Env>;
