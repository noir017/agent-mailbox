#!/usr/bin/env node
// Make the two tokens of a new mailbox and the MAILBOXES entry that goes with them.
//
//   npm run new-mailbox -- <id> [existing MAILBOXES JSON file]
//
// Prints the tokens once, to stdout, for you to hand to the agent's credential store and the
// gateway's environment. Only their SHA-256 hashes go into the Worker (`wrangler secret put
// MAILBOXES`); the relay never sees or stores a token at rest.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
  console.error('usage: new-mailbox <id> [MAILBOXES.json]   (id: lowercase letters, digits, _ and -)');
  process.exit(2);
}
let all = {};
if (process.argv[3]) all = JSON.parse(readFileSync(process.argv[3], 'utf8'));
if (all[id]) {
  console.error(`mailbox "${id}" already exists in that file`);
  process.exit(1);
}

// 32 random bytes, base64url: URL-safe, so the agent token can sit in a path segment as-is.
const token = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const hash = (t) => createHash('sha256').update(t).digest('hex');

const agent = token('mba');
const client = token('mbc');
all[id] = { agent: hash(agent), client: hash(client) };

console.log(`mailbox:      ${id}`);
console.log(`agent token:  ${agent}`);
console.log(`client token: ${client}`);
console.log('');
console.log('MAILBOXES (the whole value; put it with `npx wrangler secret put MAILBOXES`):');
console.log(JSON.stringify(all));
