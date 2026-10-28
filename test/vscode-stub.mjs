// Minimal stand-in for the `vscode` module, enough to run the provider in plain Node.
export class LanguageModelTextPart { constructor(value) { this.value = value; } }
export class LanguageModelThinkingPart { constructor(value) { this.value = value; this.thinking = true; } }
export class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
export class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
export class LanguageModelDataPart {
  constructor(data, mimeType) { Object.assign(this, { data, mimeType }); }
  static json(value, mime = 'text/x-json') { return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime); }
}
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
export const ProgressLocation = { Notification: 15 };
export class CancellationError extends Error {}
export class Disposable { constructor(fn) { this.dispose = fn; } }
export class EventEmitter {
  listeners = [];
  event = (listener) => { this.listeners.push(listener); return new Disposable(() => {}); };
  fire(value) { for (const l of this.listeners) l(value); }
}
export const Uri = { parse: (value) => ({ toString: () => value, value }) };

export const calls = { messages: [], opened: [], quickPicks: [] };
const log = (level) => (msg) => calls.messages.push(`[log:${level}] ${msg}`);
export const window = {
  createOutputChannel: () => ({ info: log('info'), warn: log('warn'), error: log('error'), show() {}, dispose() {} }),
  showInformationMessage: async (msg, ...rest) => { calls.messages.push(`[info] ${msg}`); return globalThis.__answer?.(msg, rest); },
  showWarningMessage: async (msg, ...rest) => { calls.messages.push(`[warn] ${msg}`); return undefined; },
  showErrorMessage: async (msg) => { calls.messages.push(`[error] ${msg}`); },
  showQuickPick: async (items, opts) => { calls.quickPicks.push({ items, opts }); return globalThis.__pick?.(items); },
  withProgress: (_opts, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return new Disposable(() => {}); } }),
};
export const env = {
  language: 'en',
  openExternal: async (uri) => { calls.opened.push(uri.toString()); globalThis.__onOpen?.(uri.toString()); return true; },
  clipboard: { writeText: async () => {} },
};
export const lm = { registerLanguageModelChatProvider: (vendor, provider) => { globalThis.__provider = provider; return new Disposable(() => {}); } };
export const commands = { registerCommand: (id, fn) => { (globalThis.__commands ??= {})[id] = fn; return new Disposable(() => {}); }, executeCommand: async () => {} };
export const extensions = { getExtension: () => undefined };

export function secretStorage() {
  const map = new Map();
  const changed = new EventEmitter();
  return {
    get: async (k) => map.get(k),
    store: async (k, v) => { map.set(k, v); changed.fire({ key: k }); },
    delete: async (k) => { map.delete(k); changed.fire({ key: k }); },
    onDidChange: changed.event,
    map,
  };
}
export function memento() {
  const map = new Map();
  return { get: (k, d) => (map.has(k) ? map.get(k) : d), update: async (k, v) => { map.set(k, v); }, keys: () => [...map.keys()], map };
}
