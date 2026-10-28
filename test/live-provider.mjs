// The real provider against live ChatGPT, with a saved session: node --import ./test/register.mjs test/live-provider.mjs <session.json>
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { activate } from '../out/extension.js';

const secrets = vscode.secretStorage();
await secrets.store('symbolon.session', readFileSync(process.argv[2], 'utf8'));
activate({ secrets, globalState: vscode.memento(), subscriptions: [], globalStorageUri: { fsPath: process.env.TEMP + '\\symbolon-test\\x' }, extension: { packageJSON: { displayName: 'Symbolon', version: '0.2.0' } } });
const provider = globalThis.__provider;
await provider.refresh();
const models = await provider.provideLanguageModelChatInformation({ silent: true });
console.log('models:', models.map((m) => m.id).join(', '));
const model = models.find((m) => m.id === (process.env.MODEL ?? 'gpt-6-luna')) ?? models[0];
const R = vscode.LanguageModelChatMessageRole;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const tools = [{ name: 'read_file', description: 'Read a workspace file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const options = { tools, toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: 'symbolon-live-1' }, modelConfiguration: { reasoningEffort: 'medium' } };

async function turn(messages, label) {
  const parts = [];
  await provider.provideLanguageModelChatResponse(model, messages, options, { report: (p) => parts.push(p) }, token);
  const text = parts.filter((p) => p instanceof vscode.LanguageModelTextPart).map((p) => p.value).join('');
  const kinds = [...new Set(parts.map((p) => p.mimeType ?? p.constructor.name))];
  console.log(`[${label}] parts=${kinds.join(',')} text=${JSON.stringify(text.slice(0, 160))}`);
  return parts;
}

const history = [
  { role: 3, content: [new vscode.LanguageModelTextPart('You are GitHub Copilot in VS Code. Use the read_file tool to look at files.')] },
  { role: R.User, content: [new vscode.LanguageModelTextPart('What does src/answer.ts export? Read it first.')] },
];
const first = await turn(history, 'tool call');
const call = first.find((p) => p instanceof vscode.LanguageModelToolCallPart);
if (!call) throw new Error('expected a tool call');
history.push({ role: R.Assistant, content: first.filter((p) => !(p.mimeType === 'usage')) });
history.push({ role: R.User, content: [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('export const answer = 42;')])] });
const second = await turn(history, 'after tool');
history.push({ role: R.Assistant, content: second.filter((p) => !(p.mimeType === 'usage')) });
history.push({ role: R.User, content: [new vscode.LanguageModelTextPart('Multiply that value by 3. One line.')] });
await turn(history, 'follow-up');
console.log('log:', vscode.calls.messages.filter((m) => m.startsWith('[log')).join(' | '));
process.exit(0);
