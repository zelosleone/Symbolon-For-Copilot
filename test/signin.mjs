// Live sign-in probe: node test/signin.mjs <stateDir>. Writes the authorize URL to url.txt and the account to account.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorize, newHostId } from '../out/siwc.js';

const dir = process.argv[2];
const hostFile = join(dir, 'host.txt');
const accountFile = join(dir, 'account.json');
if (!existsSync(hostFile)) writeFileSync(hostFile, newHostId());
const hostId = readFileSync(hostFile, 'utf8');
const previous = existsSync(accountFile) ? JSON.parse(readFileSync(accountFile, 'utf8')) : undefined;

const account = await authorize({
  appName: 'Symbolon',
  hostId,
  previous,
  open: async (url) => writeFileSync(join(dir, 'url.txt'), url),
  signal: new AbortController().signal,
});
writeFileSync(accountFile, JSON.stringify(account));
console.log('signed in', { email: account.email, clientId: account.clientId.slice(0, 10) + '…', scopes: account.tokens.scopes, expiresIn: Math.round((account.tokens.expiresAt - Date.now()) / 1000) });
