import * as zlib from 'node:zlib';
import { RESOURCE } from './siwc.js';

export interface ResponseItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  summary?: unknown[];
  encrypted_content?: string | null;
}

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ResponseEvent {
  type: string;
  delta?: string;
  item?: ResponseItem;
  code?: string;
  message?: string;
  response?: {
    usage?: ResponseUsage;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly requestId?: string | null,
  ) {
    super(message);
  }
}

// ChatGPT plan requests reject uncompressed bodies over about 1 MiB.
const COMPRESS_FROM_BYTES = 256 * 1024;

function encode(body: object): { data: Uint8Array; headers: Record<string, string> } {
  const json = Buffer.from(JSON.stringify(body));
  const zstd = (zlib as { zstdCompressSync?: (buffer: Buffer) => Buffer }).zstdCompressSync;
  if (json.length < COMPRESS_FROM_BYTES || !zstd) return { data: json, headers: {} };
  return { data: zstd(json), headers: { 'Content-Encoding': 'zstd' } };
}

export async function* streamResponse(
  accessToken: string,
  body: object,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<ResponseEvent> {
  const encoded = encode(body);
  const res = await fetch(`${RESOURCE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...encoded.headers,
      ...headers,
    },
    body: encoded.data,
    signal,
    redirect: 'error',
  });
  if (!res.ok || !res.body) throw await toApiError(res);
  let buffer = '';
  for await (const text of res.body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + text).split('\n');
    buffer = lines.pop() ?? '';
    yield* parseEvents(lines);
  }
  yield* parseEvents([buffer]);
}

function* parseEvents(lines: string[]): Generator<ResponseEvent> {
  for (const line of lines) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (data && data !== '[DONE]') yield JSON.parse(data) as ResponseEvent;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string } | string;
  detail?: string;
}

async function toApiError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: ErrorBody = {};
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    body = { detail: text };
  }
  const error = typeof body.error === 'string' ? { code: body.error } : body.error;
  const message = error?.message ?? body.detail ?? text;
  return new ApiError(res.status, error?.code, `ChatGPT request failed (HTTP ${res.status}). ${message}`.trim().slice(0, 500), res.headers.get('x-request-id'));
}
