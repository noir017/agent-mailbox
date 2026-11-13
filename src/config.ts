/**
 * Settings and credentials, read from the Worker's environment.
 *
 * Nothing here is in the repository: `MAILBOXES` is a Worker secret (`.dev.vars` locally) and the
 * limits are plain vars with defaults. Only SHA-256 hashes of tokens are configured — a leaked
 * secret store or a leaked `wrangler.jsonc` hands out no working token.
 */

/** One mailbox: its id and the hashes of its two tokens. */
export interface MailboxEntry {
  id: string;
  /** sha256 hex of the token the polling agent uses. */
  agentHash: string;
  /** sha256 hex of the token the gateway (client) uses. */
  clientHash: string;
}

export interface Limits {
  /** Undelivered messages and unread replies older than this are dropped. */
  ttlMs: number;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: number;
  /** Longest `text` accepted, in characters. */
  maxTextChars: number;
  /** Most messages (or replies) a mailbox holds at once per direction. */
  maxPending: number;
  /** Seconds the agent is told to wait before its next poll while the mailbox is in use. */
  pollActiveSecs: number;
  /** ...and while it is not. */
  pollIdleSecs: number;
  /** How long after the last message, either way, the mailbox counts as in use. */
  activeWindowMs: number;
}

export interface Env {
  MAILBOXES?: string;
  TTL_HOURS?: string;
  MAX_BODY_BYTES?: string;
  MAX_TEXT_CHARS?: string;
  MAX_PENDING?: string;
  POLL_ACTIVE_SECONDS?: string;
  POLL_IDLE_SECONDS?: string;
  ACTIVE_WINDOW_MINUTES?: string;
}

export const DEFAULT_LIMITS: Limits = {
  ttlMs: 7 * 24 * 3600 * 1000,
  maxBodyBytes: 128 * 1024,
  maxTextChars: 16_000,
  maxPending: 200,
  pollActiveSecs: 5,
  pollIdleSecs: 30,
  activeWindowMs: 60 * 60_000,
};

const MAILBOX_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Parse `MAILBOXES`: `{"<id>": {"agent": "<sha256 hex>", "client": "<sha256 hex>"}, ...}`.
 *
 * A malformed entry throws: a relay that silently drops a mailbox would answer its agent with 401
 * forever and nobody would know why.
 */
export function parseMailboxes(raw: string | undefined): MailboxEntry[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MAILBOXES is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MAILBOXES must be a JSON object keyed by mailbox id');
  }
  const out: MailboxEntry[] = [];
  const seen = new Set<string>();
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!MAILBOX_ID.test(id)) throw new Error(`MAILBOXES: invalid mailbox id "${id}"`);
    const v = value as { agent?: unknown; client?: unknown } | null;
    const agent = typeof v?.agent === 'string' ? v.agent.toLowerCase() : '';
    const client = typeof v?.client === 'string' ? v.client.toLowerCase() : '';
    if (!SHA256_HEX.test(agent) || !SHA256_HEX.test(client)) {
      throw new Error(`MAILBOXES: "${id}" needs "agent" and "client" as sha256 hex`);
    }
    if (agent === client) throw new Error(`MAILBOXES: "${id}" uses one token for both sides`);
    for (const h of [agent, client]) {
      if (seen.has(h)) throw new Error(`MAILBOXES: a token hash is used twice ("${id}")`);
      seen.add(h);
    }
    out.push({ id, agentHash: agent, clientHash: client });
  }
  return out;
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export function parseLimits(env: Env): Limits {
  const pollActiveSecs = Math.ceil(positive(env.POLL_ACTIVE_SECONDS, DEFAULT_LIMITS.pollActiveSecs, 'POLL_ACTIVE_SECONDS'));
  const pollIdleSecs = Math.ceil(positive(env.POLL_IDLE_SECONDS, DEFAULT_LIMITS.pollIdleSecs, 'POLL_IDLE_SECONDS'));
  // An idle interval shorter than the active one would poll hardest when nothing happens.
  if (pollIdleSecs < pollActiveSecs) {
    throw new Error(`POLL_IDLE_SECONDS (${pollIdleSecs}) is shorter than POLL_ACTIVE_SECONDS (${pollActiveSecs})`);
  }
  return {
    ttlMs: Math.round(positive(env.TTL_HOURS, DEFAULT_LIMITS.ttlMs / 3_600_000, 'TTL_HOURS') * 3_600_000),
    maxBodyBytes: Math.floor(positive(env.MAX_BODY_BYTES, DEFAULT_LIMITS.maxBodyBytes, 'MAX_BODY_BYTES')),
    maxTextChars: Math.floor(positive(env.MAX_TEXT_CHARS, DEFAULT_LIMITS.maxTextChars, 'MAX_TEXT_CHARS')),
    maxPending: Math.floor(positive(env.MAX_PENDING, DEFAULT_LIMITS.maxPending, 'MAX_PENDING')),
    pollActiveSecs,
    pollIdleSecs,
    activeWindowMs: Math.round(
      positive(env.ACTIVE_WINDOW_MINUTES, DEFAULT_LIMITS.activeWindowMs / 60_000, 'ACTIVE_WINDOW_MINUTES') * 60_000,
    ),
  };
}

/** Tokens are ours (scripts/new-mailbox.mjs): URL-safe and bounded, so they can sit in a path segment. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compare two equal-length hex strings without an early exit. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Role = 'agent' | 'client';

/**
 * The mailbox a token opens, for the given role, or undefined.
 *
 * Every entry is compared, match or not, so the time taken says nothing about which mailbox (or
 * whether any) is close. A token of the wrong role opens nothing: the agent's token cannot read
 * replies and the client's cannot read the inbox.
 */
export async function authenticate(
  mailboxes: readonly MailboxEntry[],
  role: Role,
  token: string | undefined,
): Promise<MailboxEntry | undefined> {
  if (!token || !TOKEN_PATTERN.test(token)) return undefined;
  const hash = await sha256Hex(token);
  let found: MailboxEntry | undefined;
  for (const entry of mailboxes) {
    const expected = role === 'agent' ? entry.agentHash : entry.clientHash;
    if (sameHex(hash, expected) && !found) found = entry;
  }
  return found;
}
