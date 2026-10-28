// End-to-end run of the real extension code against a mocked OpenAI.
// node --import ./test/register.mjs test/e2e.mjs <codex models.json>
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import { activate } from '../out/extension.js';

const catalog = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const realFetch = globalThis.fetch;
const seen = { authorize: [], token: [], responses: [], revoked: 0, models: 0 };
let pending; // the authorize request the fake browser is answering
let script = []; // queued /responses replies
let accessCount = 0;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims) {
  const head = b64({ alg: 'RS256', kid: 'k1' });
  const body = b64({ iss: 'https://auth.openai.com', sub: 'user-1', email: 'dev@example.com', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

function tokens(clientId, nonce) {
  accessCount += 1;
  return json({
    access_token: `at-${accessCount}`,
    refresh_token: `rt-${accessCount}`,
    id_token: idToken({ aud: clientId, nonce }),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
  });
}

function tokenEndpoint(body) {
  const form = Object.fromEntries(new URLSearchParams(body));
  seen.token.push(form);
  if (form.grant_type === 'refresh_token') return tokens(form.client_id);
  const challenge = createHash('sha256').update(form.code_verifier).digest('base64url');
  assert.equal(challenge, pending.code_challenge, 'PKCE verifier matches the challenge');
  assert.equal(form.redirect_uri, pending.redirect_uri);
  assert.equal(form.resource, 'https://api.openai.com/v1');
  assert.equal(form.client_id, 'oaiapp_test');
  return tokens(form.client_id, pending.nonce);
}

function responses(init) {
  const encoding = init.headers['Content-Encoding'];
  const raw = Buffer.from(init.body);
  const body = JSON.parse((encoding === 'zstd' ? zlib.zstdDecompressSync(raw) : raw).toString());
  seen.responses.push({ body, headers: init.headers, bytes: raw.length, encoding });
  const next = script.shift();
  return typeof next === 'function' ? next(body, init.headers) : sse(next);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  const route = `${url.hostname}${url.pathname}`;
  if (route === 'auth.openai.com/.well-known/openid-configuration') {
    return json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' });
  }
  if (route === 'auth.openai.com/.well-known/jwks.json') return json({ keys: [jwk] });
  if (route === 'auth.openai.com/api/accounts/oauth/token') return tokenEndpoint(init.body);
  if (route === 'auth.openai.com/api/accounts/oauth/revoke') { seen.revoked += 1; return new Response('', { status: 200 }); }
  if (route === 'api.openai.com/v1/models') { seen.models += 1; return json(catalog); }
  if (route === 'api.openai.com/v1/responses') return responses(init);
  throw new Error(`unexpected fetch ${route}`);
};

// The fake browser approves sign-in by calling the loopback callback.
globalThis.__onOpen = (url) => {
  const params = Object.fromEntries(new URL(url).searchParams);
  seen.authorize.push({ url, params });
  pending = params;
  if (url.includes('+')) throw new Error('authorize URL must not use + for spaces');
  const callback = new URL(params.redirect_uri);
  callback.search = new URLSearchParams({ code: 'code-1', state: params.state, client_id: 'oaiapp_test', scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke' }).toString();
  setTimeout(() => realFetch(callback).then((r) => r.text()), 20);
};
globalThis.__answer = (_msg, items) => items.find((item) => item?.title === 'Got it');

const secrets = vscode.secretStorage();
const state = vscode.memento();
activate({ secrets, globalState: state, subscriptions: [], globalStorageUri: { fsPath: process.env.TEMP + '\\symbolon-test\\x' }, extension: { packageJSON: { displayName: 'Symbolon' } } });
const provider = globalThis.__provider;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Signed out: silent discovery is empty; sign-in registers a new client.
assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }), []);
await globalThis.__commands['symbolon.signIn']();
const first = seen.authorize[0].params;
assert.equal(first.client_id, 'dynamic_agent_client');
assert.equal(first.agent_name_hint, 'Symbolon');
assert.match(first.ext_agent_host_id, /^urn:uuid:[0-9a-f-]{36}$/);
assert.equal(first.scope, 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
assert.match(first.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
assert.ok(vscode.calls.messages.some((m) => m.includes("You're using your ChatGPT plan")), 'welcome shown once');
await wait(50);

// 2. Models come from the account's catalog, models.json schema.
const models = await provider.provideLanguageModelChatInformation({ silent: true });
assert.ok(seen.models >= 1);
const listed = catalog.models.filter((m) => m.visibility === 'list').map((m) => m.slug);
assert.deepEqual(models.map((m) => m.id).sort(), listed.sort());
const model = models[0];
console.log('models:', models.map((m) => `${m.id} (${m.name}, in ${m.maxInputTokens}, out ${m.maxOutputTokens}, img ${m.capabilities.imageInput})`).join('; '));
console.log('first model options:', JSON.stringify(model.configurationSchema));

// 3. A turn with history: system, user + image, assistant tool call with replay marker, tool result.
const R = vscode.LanguageModelChatMessageRole;
const marker = new vscode.LanguageModelDataPart(new TextEncoder().encode('symbolon\\' + JSON.stringify([{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-1' }])), 'stateful_marker');
const otherMarker = new vscode.LanguageModelDataPart(new TextEncoder().encode('deepseek-for-copilot\\{}'), 'stateful_marker');
const messages = [
  { role: 3, content: [new vscode.LanguageModelTextPart('You are Copilot.')] },
  { role: R.User, content: [new vscode.LanguageModelTextPart('Read a.ts'), new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')] },
  { role: R.Assistant, content: [marker, otherMarker, new vscode.LanguageModelTextPart('Reading.'), new vscode.LanguageModelToolCallPart('call_1', 'read_file', { path: 'a.ts' })] },
  { role: R.User, content: [new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('export {}')])] },
];
const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
const parts = [];
const progress = { report: (p) => parts.push(p) };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
script.push([
  { type: 'response.created' },
  { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'enc-2' } },
  { type: 'response.output_text.delta', delta: 'Hello ' },
  { type: 'response.output_text.delta', delta: 'world' },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_2', name: 'read_file', namespace: 'functions', arguments: '{"path":"b.ts"}' } },
  { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240, input_tokens_details: { cached_tokens: 1000 } } } },
]);
const options = { tools, toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: 'github.copilot-chat', modelOptions: { _conversationId: 'conv-1' }, modelConfiguration: { reasoningEffort: 'high' } };
await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
const sent = seen.responses.at(-1);
console.log('request body:', JSON.stringify({ ...sent.body, input: sent.body.input.map((i) => i.type + (i.role ? ':' + i.role : '')) }));
assert.equal(sent.headers.Authorization, 'Bearer at-1');
assert.equal(sent.headers['session-id'], 'conv-1');
assert.equal(sent.body.store, false);
assert.equal(sent.body.stream, true);
assert.equal(sent.body.instructions, 'You are Copilot.');
assert.equal(sent.body.prompt_cache_key, 'conv-1');
assert.equal(sent.body.reasoning.effort, 'high');
assert.deepEqual(sent.body.include, ['reasoning.encrypted_content']);
assert.deepEqual(sent.body.input.map((i) => i.type), ['message', 'reasoning', 'message', 'function_call', 'function_call_output']);
assert.equal(sent.body.input[0].content[1].type, 'input_image');
assert.equal(sent.body.input[1].encrypted_content, 'enc-1');
assert.equal(sent.body.input[4].output, 'export {}');
for (const forbidden of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id', 'metadata', 'user', 'truncation']) assert.ok(!(forbidden in sent.body), forbidden);
if (model.request.lite) {
  assert.equal(sent.body.tools[0].type, 'namespace');
  assert.equal(sent.body.input[3].namespace, 'functions');
  assert.equal(sent.body.parallel_tool_calls, false);
  assert.equal(sent.body.reasoning.context, 'all_turns');
}
const kinds = parts.map((p) => p.constructor.name);
console.log('reported parts:', kinds.join(', '));
assert.equal(parts.filter((p) => p instanceof vscode.LanguageModelTextPart).map((p) => p.value).join(''), 'Hello world');
assert.ok(parts.some((p) => p.thinking && p.value === 'Thinking'));
const call = parts.find((p) => p instanceof vscode.LanguageModelToolCallPart);
assert.deepEqual([call.callId, call.name, call.input], ['call_2', 'read_file', { path: 'b.ts' }]);
const usage = parts.find((p) => p.mimeType === 'usage');
assert.deepEqual(JSON.parse(new TextDecoder().decode(usage.data)), { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240, prompt_tokens_details: { cached_tokens: 1000 } });
const newMarker = parts.find((p) => p.mimeType === 'stateful_marker');
assert.ok(new TextDecoder().decode(newMarker.data).includes('enc-2'));

// 4. A rejected access token is refreshed once and the request retried.
script.push(() => json({ error: { code: 'subscription_sharing_invalid_user', message: 'bad token' } }, 401));
script.push([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
await provider.provideLanguageModelChatResponse(model, messages.slice(0, 2), { ...options, tools: [] }, { report() {} }, token);
assert.equal(seen.token.at(-1).grant_type, 'refresh_token');
assert.equal(seen.token.at(-1).client_id, 'oaiapp_test');
assert.equal(seen.responses.at(-1).headers.Authorization, 'Bearer at-2');
assert.ok(!('tools' in seen.responses.at(-1).body));

// 5. A rejected speed tier is dropped and not sent again.
const tiered = models.find((m) => m.configurationSchema?.properties.serviceTier);
if (tiered) {
  const fast = tiered.configurationSchema.properties.serviceTier.enum.find((id) => id !== 'default');
  script.push(() => json({ error: { code: 'subscription_sharing_unsupported_capability', param: 'service_tier', message: 'no tiers' } }, 400));
  script.push([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  await provider.provideLanguageModelChatResponse(tiered, messages.slice(0, 2), { ...options, modelConfiguration: { serviceTier: fast } }, { report() {} }, token);
  assert.equal(seen.responses.at(-2).body.service_tier, fast);
  assert.ok(!('service_tier' in seen.responses.at(-1).body));
}

// 6. Usage limit surfaces a Manage usage prompt and a clear error.
script.push([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }]);
await assert.rejects(provider.provideLanguageModelChatResponse(model, messages.slice(0, 2), options, { report() {} }, token), /usage limit reached/);
assert.ok(vscode.calls.messages.some((m) => m.includes('usage limit reached')));

// 7. Other extensions can't spend the plan.
await assert.rejects(provider.provideLanguageModelChatResponse(model, messages.slice(0, 2), { ...options, requestInitiator: 'someone.else' }, { report() {} }, token), /Copilot Chat only/);

// 8. Large requests go out zstd-compressed.
script.push([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
const big = [{ role: R.User, content: [new vscode.LanguageModelTextPart('x'.repeat(2_000_000))] }];
await provider.provideLanguageModelChatResponse(model, big, options, { report() {} }, token);
console.log('large request:', seen.responses.at(-1).encoding, seen.responses.at(-1).bytes, 'bytes on the wire');
assert.equal(seen.responses.at(-1).encoding, 'zstd');

// 9. Returning sign-in reuses the issued client; sign-out revokes and keeps the registration.
await globalThis.__commands['symbolon.signOut']();
assert.equal(seen.revoked, 1);
assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }), []);
globalThis.__pick = (items) => items[0];
await globalThis.__commands['symbolon.signIn']();
const again = seen.authorize.at(-1).params;
assert.equal(again.client_id, 'oaiapp_test');
assert.ok(!('agent_name_hint' in again));
assert.equal(again.login_hint, 'dev@example.com');
assert.equal(again.ext_agent_host_id, first.ext_agent_host_id);
assert.equal(vscode.calls.messages.filter((m) => m.includes("You're using your ChatGPT plan")).length, 1);

console.log('messages:', vscode.calls.messages.join(' | '));
console.log('ALL E2E CHECKS PASSED');
process.exit(0);
