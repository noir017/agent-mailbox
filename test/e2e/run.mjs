#!/usr/bin/env node
// End-to-end: the relay under a local `wrangler dev` (workerd + a real SQLite Durable Object),
// driven over HTTP, then the Muse package's own e2e (integrations/muse/tests/test_e2e.py) against it.
// Local only: wrangler dev runs with no Cloudflare credentials and deploys nothing.
//
//   npm run test:e2e            (port: MBX_E2E_PORT, default 18840)
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.MBX_E2E_PORT ?? 18840);
const BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(path.join(tmpdir(), 'mbx-e2e-'));
const logFile = path.join(work, 'wrangler.log');

const token = (p) => `${p}_${randomBytes(32).toString('base64url')}`;
const hash = (t) => createHash('sha256').update(t).digest('hex');
const T = { alphaAgent: token('mba'), alphaClient: token('mbc'), betaAgent: token('mba'), betaClient: token('mbc') };
writeFileSync(
  path.join(work, 'env'),
  `MAILBOXES=${JSON.stringify({
    alpha: { agent: hash(T.alphaAgent), client: hash(T.alphaClient) },
    beta: { agent: hash(T.betaAgent), client: hash(T.betaClient) },
  })}\n`,
);

let child;
function startRelay() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('CLOUDFLARE_')) delete env[k];
  child = spawn(
    'npx',
    ['wrangler', 'dev', '--env-file', path.join(work, 'env'), '--ip', '127.0.0.1', '--port', String(PORT),
      '--inspector-port', String(PORT + 1), '--persist-to', path.join(work, 'state'), '--show-interactive-dev-session=false'],
    { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const append = (d) => writeFileSync(logFile, d, { flag: 'a' });
  child.stdout.on('data', append);
  child.stderr.on('data', append);
}
async function stopRelay() {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  await groupGone(child.pid);
  child = undefined;
}
/** npx exits before the wrangler and workerd under it do; wait for the whole group. */
async function groupGone(pgid) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {}
}
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`relay did not start; see ${logFile}`);
}

const call = async (method, p, { bearer, body } = {}) => {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`ok - ${label}`);
  else {
    failures++;
    console.log(`FAIL - ${label}\n  ${JSON.stringify(detail)}`);
  }
};

try {
  startRelay();
  await waitReady();
  console.log(`# relay up on ${BASE}`);

  // Auth: both placements, roles kept apart.
  check('agent token as Bearer', (await call('GET', '/agent/ping', { bearer: T.alphaAgent })).body.mailbox === 'alpha');
  check('agent token in the path', (await call('GET', `/agent${T.betaAgent}/ping`)).body.mailbox === 'beta');
  check('client token on an agent route: 401', (await call('GET', '/agent/inbox', { bearer: T.alphaClient })).status === 401);
  check('agent token on a client route: 401', (await call('GET', '/client/status', { bearer: T.alphaAgent })).status === 401);
  check('no token: 401', (await call('GET', '/client/status')).status === 401);
  check('unknown route: 404', (await call('GET', '/agent/nope', { bearer: T.alphaAgent })).status === 404);

  // A turn, through the Durable Object.
  const sent = await call('POST', '/client/send', { bearer: T.alphaClient, body: { session: 'chat', turn: 't1', text: 'hello' } });
  check('send', sent.status === 200 && sent.body.seq === 1, sent);
  check('beta sees none of it', (await call('GET', '/agent/inbox', { bearer: T.betaAgent })).body.messages.length === 0);
  const inbox = await call('GET', `/agent${T.alphaAgent}/inbox`);
  check('inbox', inbox.body.messages[0]?.text === 'hello' && inbox.body.cursor === 1, inbox);
  const rep = await call('POST', `/agent${T.alphaAgent}/reply`, { body: { session: 'chat', turn: 't1', type: 'final', text: 'hi back' } });
  check('reply', rep.status === 200, rep);
  const got = await call('GET', '/client/replies?session=chat', { bearer: T.alphaClient });
  check('replies + agent status', got.body.replies[0]?.text === 'hi back' && got.body.agent.fetched_upto === 1 && got.body.agent.last_poll_at > 0, got);
  check('limits: 413 over MAX_BODY_BYTES', (await call('POST', '/client/send', { bearer: T.alphaClient, body: { session: 'chat', text: 'x'.repeat(200_000) } })).status === 413);
  check('limits: 413 over MAX_TEXT_CHARS', (await call('POST', '/client/send', { bearer: T.alphaClient, body: { session: 'chat', text: 'x'.repeat(16_001) } })).status === 413);
  check('bad JSON: 400', (await call('POST', '/client/send', { bearer: T.alphaClient, body: '{oops' })).status === 400);

  // What a restart (or hibernation) keeps: storage, sequence numbers, the persisted poll time.
  await call('POST', '/client/send', { bearer: T.alphaClient, body: { session: 'chat', turn: 't2', text: 'survives' } });
  await stopRelay();
  startRelay();
  await waitReady();
  const after = await call('GET', '/agent/inbox?after=1', { bearer: T.alphaAgent });
  check('messages survive a restart', after.body.messages.map((m) => m.text).join() === 'survives', after);
  const st = await call('GET', '/client/status', { bearer: T.alphaClient });
  check('poll time survives a restart', st.body.agent.last_poll_at > 0, st);
  check('sequence continues', (await call('POST', '/client/send', { bearer: T.alphaClient, body: { session: 'chat', text: 'n' } })).body.seq === 3);
  await call('GET', '/agent/inbox?after=3', { bearer: T.alphaAgent });

  // The Muse package against this relay.
  console.log('# integrations/muse/tests/test_e2e.py');
  const py = spawnSync('python3', ['-m', 'unittest', '-v', 'test_e2e'], {
    cwd: path.join(ROOT, 'integrations/muse/tests'),
    env: { ...process.env, RELAY_URL: BASE, AGENT_TOKEN: T.betaAgent, CLIENT_TOKEN: T.betaClient },
    encoding: 'utf8',
    timeout: 300_000,
  });
  process.stdout.write(py.stderr);
  check('muse package e2e', py.status === 0 && !/skipped/.test(py.stderr), py.status);

  // The Worker logs nothing that carries a token. wrangler dev's own request lines print the URL —
  // the path form puts the token there, which is why production keeps request logging off.
  const log = readFileSync(logFile, 'utf8').split('\n');
  const leaks = log.filter((line) => Object.values(T).some((t) => line.includes(t)) && !/^\[wrangler:info\] (GET|POST) \/agent/.test(line));
  check('no token in any log line but wrangler dev\'s own request lines', leaks.length === 0, leaks);
} catch (err) {
  failures++;
  console.log(`FAIL - ${err instanceof Error ? err.stack : err}`);
} finally {
  await stopRelay();
  if (failures === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`(kept ${work} for inspection)`);
}
console.log(failures === 0 ? '\nall e2e checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
