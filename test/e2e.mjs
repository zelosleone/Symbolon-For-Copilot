// End-to-end run of the real extension code against a mocked ChatGPT.
// node --import ./test/register.mjs test/e2e.mjs <models.json from /models or Codex>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import { activate } from '../out/extension.js';

const catalog = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const realFetch = globalThis.fetch;
const seen = { authorize: [], token: [], responses: [], revoked: [], models: [] };
let pending;
const script = [];
let issued = 0;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const auth = { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'team', chatgpt_data_residency: 'eu' };

function tokens() {
  issued += 1;
  return json({
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 864000, 'https://api.openai.com/auth': auth }),
    refresh_token: `rt-${issued}`,
    id_token: jwt({ email: 'dev@example.com', 'https://api.openai.com/auth': auth }),
    expires_in: 864000,
  });
}

function tokenEndpoint(body) {
  const form = Object.fromEntries(new URLSearchParams(body));
  seen.token.push(form);
  assert.equal(form.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  if (form.grant_type === 'refresh_token') return tokens();
  assert.equal(createHash('sha256').update(form.code_verifier).digest('base64url'), pending.code_challenge, 'PKCE verifier matches');
  assert.equal(form.redirect_uri, pending.redirect_uri);
  return tokens();
}

function responses(init) {
  const raw = Buffer.from(init.body);
  const body = JSON.parse((init.headers['Content-Encoding'] === 'zstd' ? zlib.zstdDecompressSync(raw) : raw).toString());
  seen.responses.push({ body, headers: init.headers, bytes: raw.length, encoding: init.headers['Content-Encoding'] });
  const next = script.shift();
  return typeof next === 'function' ? next(body) : sse(next);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
  const route = `${url.hostname}${url.pathname}`;
  if (route === 'auth.openai.com/oauth/token') return tokenEndpoint(init.body);
  if (route === 'auth.openai.com/oauth/revoke') { seen.revoked.push(JSON.parse(init.body)); return new Response('', { status: 200 }); }
  if (route === 'chatgpt.com/backend-api/codex/models') { seen.models.push({ url: String(input), headers: init.headers }); return json(catalog); }
  if (route === 'chatgpt.com/backend-api/codex/responses') return responses(init);
  throw new Error(`unexpected fetch ${route}`);
};

// The fake browser approves sign-in by calling the loopback callback.
globalThis.__onOpen = (url) => {
  const params = Object.fromEntries(new URL(url).searchParams);
  seen.authorize.push({ url, params });
  pending = params;
  const callback = new URL(params.redirect_uri);
  callback.search = new URLSearchParams({ code: 'code-1', state: params.state, scope: params.scope }).toString();
  setTimeout(() => realFetch(callback).then((r) => r.text()), 20);
};

const secrets = vscode.secretStorage();
const state = vscode.memento();
activate({ secrets, globalState: state, subscriptions: [], globalStorageUri: { fsPath: process.env.TEMP + '\\symbolon-test\\x' }, extension: { packageJSON: { displayName: 'Symbolon', version: '9.9.9' } } });
const provider = globalThis.__provider;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Signed out: nothing listed; sign-in runs Codex's browser OAuth on the registered loopback port.
assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }), []);
await globalThis.__commands['symbolon.signIn']();
const first = seen.authorize[0];
assert.ok(first.url.startsWith('https://auth.openai.com/oauth/authorize?'));
assert.equal(first.params.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
assert.equal(first.params.redirect_uri, 'http://localhost:1455/auth/callback');
assert.equal(first.params.scope, 'openid profile email offline_access');
assert.equal(first.params.code_challenge_method, 'S256');
assert.ok(!first.url.includes('+'), 'spaces encoded as %20');
assert.ok(vscode.calls.messages.some((m) => m.includes('signed in as dev@example.com')));
await wait(50);

// 2. Models come from the account's /models catalog (models.json schema) with account headers.
const models = await provider.provideLanguageModelChatInformation({ silent: true });
const call = seen.models.at(-1);
assert.match(call.url, /client_version=/);
assert.equal(call.headers['ChatGPT-Account-ID'], 'acct-1');
assert.equal(call.headers['x-openai-internal-codex-residency'], 'eu');
assert.equal(call.headers.originator, 'symbolon');
assert.equal(call.headers['User-Agent'], 'Symbolon/9.9.9');
const listed = catalog.models.filter((m) => m.visibility === 'list').map((m) => m.slug);
assert.deepEqual(models.map((m) => m.id).sort(), listed.sort());
const model = models[0];
console.log('models:', models.map((m) => `${m.id} (${m.name}, in ${m.maxInputTokens}, out ${m.maxOutputTokens})`).join('; '));

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
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
script.push([
  { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'enc-2' } },
  { type: 'response.output_text.delta', delta: 'Hello ' },
  { type: 'response.output_text.delta', delta: 'world' },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_2', name: 'read_file', namespace: 'functions', arguments: '{"path":"b.ts"}' } },
  { type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240, input_tokens_details: { cached_tokens: 1000 } } } },
]);
const options = { tools, toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: 'conv-1' }, modelConfiguration: { reasoningEffort: 'high' } };
await provider.provideLanguageModelChatResponse(model, messages, options, { report: (p) => parts.push(p) }, token);
const sent = seen.responses.at(-1);
console.log('request body:', JSON.stringify({ ...sent.body, input: sent.body.input.map((i) => i.type + (i.role ? ':' + i.role : '')) }));
assert.equal(sent.headers.Authorization.startsWith('Bearer '), true);
assert.equal(sent.headers['ChatGPT-Account-ID'], 'acct-1');
assert.equal(sent.headers['session-id'], 'conv-1');
assert.equal(sent.body.store, false);
assert.equal(sent.body.instructions, 'You are Copilot.');
assert.equal(sent.body.prompt_cache_key, 'conv-1');
assert.equal(sent.body.reasoning.effort, 'high');
assert.deepEqual(sent.body.input.map((i) => i.type), ['message', 'reasoning', 'message', 'function_call', 'function_call_output']);
assert.equal(sent.body.input[1].encrypted_content, 'enc-1');
if (model.request.lite) {
  assert.equal(sent.body.tools[0].type, 'namespace');
  assert.equal(sent.body.input[3].namespace, 'functions');
  assert.equal(sent.body.reasoning.context, 'all_turns');
}
assert.equal(parts.filter((p) => p instanceof vscode.LanguageModelTextPart).map((p) => p.value).join(''), 'Hello world');
assert.ok(parts.some((p) => p.thinking && p.value === 'Thinking'));
const toolCall = parts.find((p) => p instanceof vscode.LanguageModelToolCallPart);
assert.deepEqual([toolCall.callId, toolCall.name, toolCall.input], ['call_2', 'read_file', { path: 'b.ts' }]);
assert.deepEqual(JSON.parse(new TextDecoder().decode(parts.find((p) => p.mimeType === 'usage').data)).prompt_tokens_details, { cached_tokens: 1000 });
assert.ok(new TextDecoder().decode(parts.find((p) => p.mimeType === 'stateful_marker').data).includes('enc-2'));

// 4. A rejected access token is refreshed once and the request retried.
script.push(() => json({ detail: 'expired' }, 401));
script.push([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
await provider.provideLanguageModelChatResponse(model, messages.slice(0, 2), { ...options, tools: [] }, { report() {} }, token);
assert.equal(seen.token.at(-1).grant_type, 'refresh_token');
assert.equal(seen.token.at(-1).refresh_token, 'rt-1');
assert.ok(!('tools' in seen.responses.at(-1).body));

// 5. A rejected speed tier is dropped and not sent again.
const tiered = models.find((m) => m.configurationSchema?.properties.serviceTier);
if (tiered) {
  const fast = tiered.configurationSchema.properties.serviceTier.enum.find((id) => id !== 'default');
  script.push(() => json({ error: { message: 'Unsupported service_tier', type: 'invalid_request_error' } }, 400));
  script.push([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
  await provider.provideLanguageModelChatResponse(tiered, messages.slice(0, 2), { ...options, modelConfiguration: { serviceTier: fast } }, { report() {} }, token);
  assert.equal(seen.responses.at(-2).body.service_tier, fast);
  assert.ok(!('service_tier' in seen.responses.at(-1).body));
}

// 6. The Codex usage limit surfaces with its reset time and a Usage limits prompt.
script.push(() => json({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 377 } }, 429));
await assert.rejects(provider.provideLanguageModelChatResponse(model, messages.slice(0, 2), options, { report() {} }, token), /usage limit reached; it resets in 7 min/);

// 7. Large requests go out zstd-compressed.
script.push([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]);
await provider.provideLanguageModelChatResponse(model, [{ role: R.User, content: [new vscode.LanguageModelTextPart('x'.repeat(2_000_000))] }], options, { report() {} }, token);
assert.equal(seen.responses.at(-1).encoding, 'zstd');

// 8. Sign-out revokes the refresh token and clears the session.
await globalThis.__commands['symbolon.signOut']();
assert.equal(seen.revoked.at(-1).token_type_hint, 'refresh_token');
assert.equal(seen.revoked.at(-1).token, 'rt-2');
assert.deepEqual(await provider.provideLanguageModelChatInformation({ silent: true }), []);

console.log('messages:', vscode.calls.messages.join(' | '));
console.log('ALL E2E CHECKS PASSED');
process.exit(0);
