import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { NotSignedInError, USAGE_URL, type Auth } from './auth.js';
import { fetchAccountCatalog, fetchCodexCatalog, type CatalogModel } from './catalog.js';
import type { Session } from './chatgpt.js';
import { createMarker, toInput, toTools } from './convert.js';
import { configured, DEFAULT_TIER, toModels, type SymbolonModel } from './models.js';
import { ApiError, streamResponse, type ResponseEvent, type ResponseItem, type ResponseUsage } from './responses.js';

const MODELS_KEY = 'symbolon.models';
const CHARS_PER_TOKEN_KEY = 'symbolon.charsPerToken';

type Options = vscode.ProvideLanguageModelChatResponseOptions & Record<string, unknown>;

interface Retry {
  body: Record<string, unknown>;
  refresh: boolean;
}

interface Turn {
  model: SymbolonModel;
  chars: number;
  reasoning: ResponseItem[];
  completed: boolean;
  // Once output reached Copilot, a retry would repeat it.
  streamed: boolean;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
}

type ThinkingCtor = new (value: string) => vscode.LanguageModelResponsePart;
const Thinking = (vscode as unknown as { LanguageModelThinkingPart?: ThinkingCtor }).LanguageModelThinkingPart;

export class SymbolonProvider implements vscode.LanguageModelChatProvider<SymbolonModel> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private models: SymbolonModel[];
  private charsPerToken: number;
  // Set when the backend turns down speed tiers, so later requests stop sending them.
  private tiersRejected = false;

  constructor(
    private readonly state: vscode.Memento,
    private readonly auth: Auth,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.models = state.get<SymbolonModel[]>(MODELS_KEY, []);
    this.charsPerToken = state.get(CHARS_PER_TOKEN_KEY, 4);
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<SymbolonModel[]> {
    if (await this.auth.current()) return this.models;
    if (!options.silent) void this.auth.signIn();
    return [];
  }

  async provideLanguageModelChatResponse(
    model: SymbolonModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: Options,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const body = this.buildBody(model, messages, options);
    const turn: Turn = { model, chars: payloadChars(body), reasoning: [], completed: false, streamed: false, progress };
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      await this.send(body, sessionId(options, messages), turn, abort.signal);
    } catch (error) {
      if (!token.isCancellationRequested) throw this.explain(error);
    } finally {
      cancel.dispose();
    }
  }

  // Copilot calls this for every key and string of every tool schema, so round instead of ceil.
  async provideTokenCount(_model: SymbolonModel, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const chars = typeof text === 'string' ? text.length : payloadChars(toInput([text], false));
    return Math.max(1, Math.round(chars / this.charsPerToken));
  }

  async refresh(): Promise<void> {
    const session = await this.auth.session().catch(() => undefined);
    if (!session) return;
    const catalog = await this.catalog(session);
    if (catalog) this.setModels(toModels(catalog));
  }

  // The account's own catalog decides; Codex's models.json covers an unreachable /models.
  private async catalog(session: Session): Promise<CatalogModel[] | undefined> {
    try {
      return await fetchAccountCatalog(session);
    } catch (error) {
      this.log.warn(`Account model list failed, using Codex's models.json: ${(error as Error).message}`);
    }
    return fetchCodexCatalog(session.plan).catch((error: unknown) => {
      this.log.warn(`Model refresh failed: ${(error as Error).message}`);
      return undefined;
    });
  }

  accountChanged(): void {
    this.changed.fire();
    void this.refresh();
  }

  // Unchanged catalogs keep the same objects, so open picker menus stay put.
  private setModels(models: SymbolonModel[]): void {
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    void this.state.update(MODELS_KEY, models);
    this.changed.fire();
  }

  // The Codex backend keeps nothing server-side: store off, full history every turn.
  private buildBody(model: SymbolonModel, messages: readonly vscode.LanguageModelChatRequestMessage[], options: Options) {
    const { lite, verbosity } = model.request;
    const tier = configured(model, options, 'serviceTier');
    const sendTier = tier !== undefined && tier !== DEFAULT_TIER && !this.tiersRejected;
    return {
      model: model.id,
      stream: true,
      store: false,
      ...(sendTier ? { service_tier: tier } : {}),
      ...toInput(messages, lite),
      ...toolFields(model, options),
      reasoning: reasoningFields(model, options),
      include: ['reasoning.encrypted_content'],
      ...(verbosity ? { text: { verbosity } } : {}),
    };
  }

  private async send(body: Record<string, unknown>, session: string, turn: Turn, signal: AbortSignal, retry?: Retry): Promise<void> {
    try {
      await this.stream(retry?.body ?? body, session, turn, signal, retry?.refresh === true);
    } catch (error) {
      const next = retry || turn.streamed ? undefined : this.retryable(error, body);
      if (!next) throw error;
      await this.send(body, session, turn, signal, next);
    }
  }

  private async stream(body: Record<string, unknown>, session: string, turn: Turn, signal: AbortSignal, refreshed: boolean): Promise<void> {
    const account = await this.auth.session(refreshed);
    const request = { ...body, prompt_cache_key: session };
    const headers = { 'session-id': session, 'thread-id': session };
    for await (const event of streamResponse(account, request, headers, signal)) this.onEvent(event, turn);
    if (turn.reasoning.length > 0) turn.progress.report(createMarker(turn.reasoning));
    if (!turn.completed) throw new Error('The ChatGPT response ended before it completed. Try again.');
  }

  /** One retry: with a refreshed token after a 401, or without the speed tier the backend turned down. */
  private retryable(error: unknown, body: Record<string, unknown>): Retry | undefined {
    if (!(error instanceof ApiError)) return undefined;
    if (error.status === 401) return { body, refresh: true };
    if (error.status !== 400 || !error.message.includes('service_tier') || !('service_tier' in body)) return undefined;
    this.tiersRejected = true;
    this.log.warn('ChatGPT rejected the speed tier; sending standard speed from now on.');
    const rest = { ...body };
    delete rest.service_tier;
    return { body: rest, refresh: false };
  }

  private onEvent(event: ResponseEvent, turn: Turn): void {
    const handler = EVENTS[event.type];
    if (handler) handler(event, turn, this);
  }

  recordUsage(usage: ResponseUsage, turn: Turn): void {
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    // Copilot reads this data part to drive its context window indicator.
    turn.progress.report(
      vscode.LanguageModelDataPart.json(
        {
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
          prompt_tokens_details: { cached_tokens: cached },
        },
        'usage',
      ),
    );
    const ratio = Math.min(12, Math.max(1, turn.chars / Math.max(1, usage.input_tokens)));
    this.charsPerToken = this.charsPerToken * 0.7 + ratio * 0.3;
    void this.state.update(CHARS_PER_TOKEN_KEY, this.charsPerToken);
    this.log.info(`${turn.model.id}: ${usage.input_tokens} input (${cached} cached), ${usage.output_tokens} output`);
  }

  private explain(error: unknown): unknown {
    if (error instanceof NotSignedInError) void this.auth.signIn();
    if (!(error instanceof ApiError)) return error;
    this.log.error(`${error.message} (code ${error.code ?? 'none'})`);
    if (error.code !== 'usage_limit_reached') return error;
    const message = `ChatGPT usage limit reached${resetsIn(error.resetsInSeconds)}.`;
    void manageUsage(`Symbolon: ${message}`);
    return new Error(message);
  }
}

function resetsIn(seconds: number | undefined): string {
  if (!seconds) return '';
  const minutes = Math.ceil(seconds / 60);
  return minutes < 120 ? `; it resets in ${minutes} min` : `; it resets in ${Math.round(minutes / 60)} h`;
}

function toolFields(model: SymbolonModel, options: Options): Record<string, unknown> {
  const tools = toTools(options.tools ?? [], model.request.lite);
  if (tools.length === 0) return {};
  return { tools, tool_choice: toolChoice(options), parallel_tool_calls: model.request.parallelToolCalls };
}

function reasoningFields(model: SymbolonModel, options: Options): Record<string, string> {
  const effort = configured(model, options, 'reasoningEffort');
  const { summaries, lite } = model.request;
  // Responses Lite keeps reasoning from earlier turns, which the replay markers carry back.
  return { ...(effort && { effort }), ...(summaries && { summary: 'auto' }), ...(lite && { context: 'all_turns' }) };
}

type Handler = (event: ResponseEvent, turn: Turn, provider: SymbolonProvider) => void;

const EVENTS: Record<string, Handler> = {
  'response.output_text.delta': (event, turn) => {
    if (event.delta) report(turn, new vscode.LanguageModelTextPart(event.delta));
  },
  'response.reasoning_summary_text.delta': (event, turn) => {
    if (event.delta && Thinking) report(turn, new Thinking(event.delta));
  },
  'response.output_item.done': (event, turn) => onItem(event.item, turn),
  'response.completed': (event, turn, provider) => {
    turn.completed = true;
    if (event.response?.usage) provider.recordUsage(event.response.usage, turn);
  },
  'response.failed': (event) => {
    const error = event.response?.error;
    throw new ApiError(200, error?.code, `ChatGPT request failed: ${error?.message ?? error?.code ?? 'unknown error'}`);
  },
  'response.incomplete': (event) => {
    throw new Error(`ChatGPT stopped early (${event.response?.incomplete_details?.reason ?? 'incomplete'}).`);
  },
  error: (event) => {
    throw new ApiError(200, event.code, `ChatGPT request failed: ${event.message ?? event.code ?? 'unknown error'}`);
  },
};

function onItem(item: ResponseItem | undefined, turn: Turn): void {
  if (item?.type === 'reasoning' && item.encrypted_content) turn.reasoning.push(item);
  if (item?.type !== 'function_call' || !item.call_id || !item.name) return;
  report(turn, new vscode.LanguageModelToolCallPart(item.call_id, item.name, parseArgs(item.arguments)));
}

function report(turn: Turn, part: vscode.LanguageModelResponsePart): void {
  turn.streamed = true;
  turn.progress.report(part);
}

function toolChoice(options: Options): string {
  return options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}

// Copilot's conversation id keeps prompt-cache affinity; otherwise the first user message stands in for it.
function sessionId(options: Options, messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  const id: unknown = (options.modelOptions as Record<string, unknown> | undefined)?._conversationId;
  if (typeof id === 'string' && id) return id;
  const first = messages.find((message) => message.role === vscode.LanguageModelChatMessageRole.User);
  return createHash('sha256').update(JSON.stringify(first?.content ?? '')).digest('hex').slice(0, 32);
}

// Everything the API tokenizes, minus image data, which is billed as image tokens.
function payloadChars(value: unknown): number {
  return JSON.stringify(value, (key, item: unknown) => (key === 'image_url' ? '' : item)).length;
}

function parseArgs(args: string | undefined): object {
  try {
    return JSON.parse(args || '{}') as object;
  } catch {
    return {};
  }
}

async function manageUsage(message: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(message, 'Manage usage');
  if (choice) await vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
}
