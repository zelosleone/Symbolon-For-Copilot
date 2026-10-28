// Identity-only live probe (no plan scope): sign in, refresh, then revoke.
// node test/identity.mjs <stateDir>   (needs account.json with a saved clientId)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorize, refresh, revoke } from '../out/siwc.js';

const dir = process.argv[2];
const previous = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8'));
const account = await authorize({
  appName: 'Symbolon',
  hostId: readFileSync(join(dir, 'host.txt'), 'utf8'),
  previous,
  scopes: 'openid profile email offline_access',
  open: async (url) => writeFileSync(join(dir, 'url.txt'), url),
  signal: new AbortController().signal,
});
console.log('signed in', { subject: account.subject.slice(0, 6) + '…', email: account.email, scopes: account.tokens.scopes });
const models = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${account.tokens.accessToken}` } });
console.log('models without plan scope', models.status, (await models.text()).slice(0, 300));
const renewed = await refresh(account);
console.log('refreshed', renewed.tokens.accessToken !== account.tokens.accessToken, renewed.tokens.refreshToken !== account.tokens.refreshToken, Math.round((renewed.tokens.expiresAt - Date.now()) / 1000));
writeFileSync(join(dir, 'account.json'), JSON.stringify({ ...renewed, tokens: undefined }));
console.log('revoked', await revoke(renewed));
const after = await refresh(renewed).then(() => 'still valid', (error) => `${error.constructor.name} ${error.code}`);
console.log('refresh after revoke', after);
