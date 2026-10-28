import * as vscode from 'vscode';
import type { ResponseItem } from './responses.js';

// Copilot sends its system prompt with the proposed System role, which the stable typings lack.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;
// Responses Lite models take function tools grouped under Codex's default namespace.
const NAMESPACE = 'functions';
// VS Code hands data parts with this MIME back to the provider on later turns.
const MARKER_MIME = 'stateful_marker';
const MARKER_PREFIX = 'symbolon\\';

type InputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };
export type InputItem = Record<string, unknown>;

export interface Converted {
  instructions: string;
  input: InputItem[];
}

export function toInput(messages: readonly vscode.LanguageModelChatRequestMessage[], lite: boolean): Converted {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const message of messages) {
    // The plan route rejects system items; Copilot's system prompt becomes the instructions.
    if (message.role === SYSTEM_ROLE) instructions.push(texts(message.content).join('\n'));
    else if (message.role === vscode.LanguageModelChatMessageRole.User) input.push(...userItems(message.content));
    else input.push(...assistantItems(message.content, lite));
  }
  return { instructions: instructions.join('\n\n'), input };
}

function userItems(content: readonly unknown[]): InputItem[] {
  // Tool results answer the calls of the assistant message right before them.
  const results = content.filter((part) => part instanceof vscode.LanguageModelToolResultPart).map(toToolOutput);
  const parts = inputContent(content);
  return parts.length > 0 ? [...results, { type: 'message', role: 'user', content: parts }] : results;
}

function assistantItems(content: readonly unknown[], lite: boolean): InputItem[] {
  const text = texts(content).join('');
  const message = text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : [];
  const calls = content
    .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
    .map((part) => ({
      type: 'function_call',
      call_id: part.callId,
      name: part.name,
      arguments: JSON.stringify(part.input ?? {}),
      ...(lite ? { namespace: NAMESPACE } : {}),
    }));
  return [...readMarker(content), ...message, ...calls];
}

function texts(content: readonly unknown[]): string[] {
  return content.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value);
}

function inputContent(content: readonly unknown[]): InputContent[] {
  const parts: InputContent[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart && part.value) parts.push({ type: 'input_text', text: part.value });
    else if (isImage(part)) parts.push(toImage(part));
  }
  return parts;
}

function isImage(part: unknown): part is vscode.LanguageModelDataPart {
  return part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/');
}

function toImage(part: vscode.LanguageModelDataPart): InputContent {
  return { type: 'input_image', image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` };
}

function toToolOutput(part: vscode.LanguageModelToolResultPart): InputItem {
  const content = inputContent(part.content);
  const hasImage = content.some((item) => item.type === 'input_image');
  const text = content.map((item) => (item.type === 'input_text' ? item.text : '')).join('\n');
  const output = hasImage ? content : text || JSON.stringify(part.content);
  return { type: 'function_call_output', call_id: part.callId, output };
}

export function toTools(tools: readonly vscode.LanguageModelChatTool[], lite: boolean): InputItem[] {
  const functions = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
  if (!lite || functions.length === 0) return functions;
  return [{ type: 'namespace', name: NAMESPACE, description: '', tools: functions }];
}

/** Carries a turn's encrypted reasoning inside the conversation, so it is replayed with that turn only. */
export function createMarker(reasoning: ResponseItem[]): vscode.LanguageModelDataPart {
  const items = reasoning.map(({ type, id, summary, encrypted_content }) => ({ type, id, summary, encrypted_content }));
  return new vscode.LanguageModelDataPart(new TextEncoder().encode(MARKER_PREFIX + JSON.stringify(items)), MARKER_MIME);
}

function readMarker(content: readonly unknown[]): InputItem[] {
  for (const part of content) {
    if (!(part instanceof vscode.LanguageModelDataPart) || part.mimeType !== MARKER_MIME) continue;
    const text = new TextDecoder().decode(part.data);
    // Other providers write markers with the same MIME; only read back our own.
    if (!text.startsWith(MARKER_PREFIX)) continue;
    try {
      return JSON.parse(text.slice(MARKER_PREFIX.length)) as InputItem[];
    } catch {
      return [];
    }
  }
  return [];
}
