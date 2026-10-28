// Live probe against ChatGPT: node test/live.mjs <stateDir> [signin]
// Signs in (writes url.txt, then session.json), lists models, and runs one streamed request with a tool.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { API_BASE, apiHeaders, authorize, identify, refresh } from '../out/chatgpt.js';

const dir = process.argv[2];
const file = join(dir, 'session.json');
identify('Symbolon', '0.2.0-dev');
let session = existsSync(file) && process.argv[3] !== 'signin' ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
if (!session) {
  session = await authorize(async (url) => writeFileSync(join(dir, 'url.txt'), url), new AbortController().signal);
  writeFileSync(file, JSON.stringify(session));
  console.log('signed in', { email: session.email, plan: session.plan, account: !!session.accountId, expiresIn: Math.round((session.expiresAt - Date.now()) / 1000) });
}
if (session.expiresAt - Date.now() < 300_000) {
  session = await refresh(session);
  writeFileSync(file, JSON.stringify(session));
  console.log('refreshed');
}

const models = await fetch(`${API_BASE}/models?client_version=99.0.0`, { headers: apiHeaders(session) });
const catalog = await models.json();
const listed = (catalog.models ?? []).filter((m) => m.visibility === 'list');
console.log('models', models.status, listed.map((m) => `${m.slug}[lite=${m.use_responses_lite} tiers=${(m.service_tiers ?? []).map((t) => t.id)} efforts=${(m.supported_reasoning_levels ?? []).map((l) => l.effort)}]`).join(' '));
writeFileSync(join(dir, 'models.json'), JSON.stringify(catalog));

const model = process.env.MODEL ?? listed[0]?.slug;
const lite = listed.find((m) => m.slug === model)?.use_responses_lite === true;
const fn = { type: 'function', name: 'read_file', description: 'Read a file from the workspace', strict: false, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
async function run(body, label) {
  const json = Buffer.from(JSON.stringify(body));
  const res = await fetch(`${API_BASE}/responses`, {
    method: 'POST',
    headers: { ...apiHeaders(session), 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Encoding': 'zstd', 'session-id': 'probe-1', 'thread-id': 'probe-1' },
    body: zlib.zstdCompressSync(json),
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return {}; } });
  const out = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  const items = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  const done = events.find((e) => ['response.completed', 'response.failed', 'response.incomplete'].includes(e.type));
  console.log(`[${label}] HTTP ${res.status} ${done?.type ?? 'no terminal event'} text=${JSON.stringify(out.slice(0, 120))}`);
  console.log(`  items: ${items.map((i) => `${i.type}${i.namespace ? '@' + i.namespace : ''}${i.name ? ':' + i.name : ''}${i.encrypted_content ? '+enc' : ''}`).join(', ')}`);
  console.log(`  usage: ${JSON.stringify(done?.response?.usage ?? null)} error: ${JSON.stringify(done?.response?.error ?? null)}`);
  if (!res.ok) console.log('  body:', text.slice(0, 400));
  console.log(`  rate headers: ${[...res.headers].filter(([k]) => k.includes('codex') || k.includes('ratelimit')).map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 300)}`);
  return items;
}

const tools = lite ? [{ type: 'namespace', name: 'functions', description: '', tools: [fn] }] : [fn];
const base = { model, stream: true, store: false, instructions: 'You are a coding assistant inside VS Code. Use tools when asked about files.', include: ['reasoning.encrypted_content'], reasoning: { effort: process.env.EFFORT ?? 'low', summary: 'auto', ...(lite ? { context: 'all_turns' } : {}) }, prompt_cache_key: 'probe-1' };
const first = await run({ ...base, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: (process.env.PROMPT ?? 'Read the file a.ts and tell me what it exports.') }] }], tools, tool_choice: 'auto', parallel_tool_calls: !lite }, 'tool call');
const call = first.find((i) => i.type === 'function_call');
if (call) {
  const reasoning = first.filter((i) => i.type === 'reasoning').map(({ type, id, summary, encrypted_content }) => ({ type, id, summary, encrypted_content }));
  await run({ ...base, tools, tool_choice: 'auto', parallel_tool_calls: !lite, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: (process.env.PROMPT ?? 'Read the file a.ts and tell me what it exports.') }] },
    ...reasoning,
    { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments, ...(lite ? { namespace: 'functions' } : {}) },
    { type: 'function_call_output', call_id: call.call_id, output: process.env.TOOL_OUT ?? 'export const answer = 42;' },
  ] }, 'tool result');
  const second = await run({ ...base, tools, tool_choice: 'auto', parallel_tool_calls: !lite, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: process.env.PROMPT ?? 'Read the file a.ts and tell me what it exports.' }] },
    { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments, ...(lite ? { namespace: 'functions' } : {}) },
    { type: 'function_call_output', call_id: call.call_id, output: process.env.TOOL_OUT ?? 'export const answer = 42;' },
  ] }, 'replay source');
  const replay = second.filter((i) => i.type === 'reasoning').map(({ type, id, summary, encrypted_content }) => ({ type, id, summary, encrypted_content }));
  const said = second.filter((i) => i.type === 'message').flatMap((i) => i.content ?? []).map((c) => c.text ?? '').join('');
  if (replay.length) await run({ ...base, tools, tool_choice: 'auto', parallel_tool_calls: !lite, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: process.env.PROMPT ?? 'Read the file a.ts and tell me what it exports.' }] },
    { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments, ...(lite ? { namespace: 'functions' } : {}) },
    { type: 'function_call_output', call_id: call.call_id, output: process.env.TOOL_OUT ?? 'export const answer = 42;' },
    ...replay,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: said }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is that value of n times 3? One line.' }] },
  ] }, `replayed ${replay.length} reasoning`);
}
const tierModel = listed.find((m) => m.slug === model)?.service_tiers?.[0]?.id;
if (tierModel) await run({ ...base, service_tier: tierModel, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say ok.' }] }] }, `tier ${tierModel}`);
