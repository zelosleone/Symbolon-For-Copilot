import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ChatGPT sign-in through Codex's public OAuth client: the same login Codex CLI and Hermes Agent use.
const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const SCOPES = 'openid profile email offline_access';
// The redirect URIs registered with that client: port 1455, or 1457 when 1455 is taken.
const PORTS = [1455, 1457];
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
export const API_BASE = 'https://chatgpt.com/backend-api/codex';
const UNUSABLE_REFRESH = new Set(['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  residency?: string;
  email?: string;
  plan?: string;
}

export class SignInError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The refresh token can no longer be used; the user has to sign in again. */
export class SessionExpiredError extends SignInError {}

let agent = 'Symbolon';

/** Third-party clients of the Codex backend identify themselves rather than posing as Codex. */
export function identify(name: string, version: string): void {
  agent = `${name}/${version}`;
}

export function apiHeaders(session: Session): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    originator: 'symbolon',
    'User-Agent': agent,
    ...(session.accountId ? { 'ChatGPT-Account-ID': session.accountId } : {}),
    // Residency-enforced workspaces answer 401 without it.
    ...(session.residency ? { 'x-openai-internal-codex-residency': session.residency } : {}),
  };
}

const random = (): string => randomBytes(32).toString('base64url');

export async function authorize(open: (url: string) => PromiseLike<unknown>, signal: AbortSignal): Promise<Session> {
  const state = random();
  const verifier = random();
  const listener = await listen(state, signal);
  try {
    const query = {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: listener.redirectUri,
      scope: SCOPES,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      state,
    };
    const params = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    await open(`${ISSUER}/oauth/authorize?${params.join('&')}`);
    const code = await listener.result;
    const data = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: listener.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });
    return toSession(data);
  } finally {
    listener.close();
  }
}

interface Listener {
  redirectUri: string;
  result: Promise<string>;
  close: () => void;
}

async function listen(state: string, signal: AbortSignal): Promise<Listener> {
  let settle!: (value: string | Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    settle = (value) => (value instanceof Error ? reject(value) : resolve(value));
  });
  void result.catch(() => undefined);
  const server = createServer((req, res) => onCallback(req, res, state, settle));
  const port = await bind(server);
  const timer = setTimeout(() => settle(new SignInError('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS);
  const abort = (): void => settle(new SignInError('Sign-in was cancelled.', 'cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const close = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  return { redirectUri: `http://localhost:${port}${CALLBACK_PATH}`, result, close };
}

async function bind(server: ReturnType<typeof createServer>): Promise<number> {
  for (const port of PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (bound) return port;
  }
  throw new SignInError('Ports 1455 and 1457 are busy, probably another ChatGPT sign-in (Codex CLI?). Finish or close it and try again.');
}

function onCallback(req: IncomingMessage, res: ServerResponse, state: string, settle: (value: string | Error) => void): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end('Not found');
    return;
  }
  // Unrelated loopback requests must not consume the pending sign-in.
  if (!sameSecret(url.searchParams.get('state') ?? '', state)) {
    res.writeHead(400).end('Invalid sign-in state. Return to the browser tab that started sign-in.');
    return;
  }
  const outcome = callbackOutcome(url.searchParams);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page(outcome instanceof Error ? outcome.message : 'Signed in. You can close this tab and return to VS Code.'));
  settle(outcome);
}

function callbackOutcome(params: URLSearchParams): string | SignInError {
  const code = params.get('code');
  const error = params.get('error') ?? undefined;
  if (code && !error) return code;
  return new SignInError(params.get('error_description') ?? `ChatGPT sign-in failed: ${error ?? 'no code'}.`, error);
}

function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(message: string): string {
  const text = message.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>Symbolon</title><body style="font:16px system-ui;max-width:32rem;margin:18vh auto;padding:24px"><h1 style="font-size:22px">Symbolon</h1><p>${text}</p></body>`;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string | { code?: string; message?: string };
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': agent },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenReply;
  if (res.ok) return data;
  throw tokenError(data, res.status, params.grant_type === 'refresh_token');
}

function tokenError(data: TokenReply, status: number, refreshing: boolean): SignInError {
  const code = typeof data.error === 'string' ? data.error : (data.error?.code ?? `http_${status}`);
  const message = `ChatGPT sign-in failed (${code}). ${data.error_description ?? ''}`.trim();
  const expired = refreshing && (UNUSABLE_REFRESH.has(code) || status === 401);
  return expired ? new SessionExpiredError(message, code) : new SignInError(message, code);
}

export async function refresh(session: Session): Promise<Session> {
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLIENT_ID });
  return toSession(data, session);
}

/** Ends the session with OpenAI. Returns false when that could not be confirmed. */
export async function revoke(session: Session): Promise<boolean> {
  try {
    const res = await fetch(`${ISSUER}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': agent },
      body: JSON.stringify({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface AuthClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  chatgpt_data_residency?: string;
  chatgpt_compute_residency?: string;
}

interface Claims {
  exp?: number;
  email?: string;
  'https://api.openai.com/auth'?: AuthClaims;
  'https://api.openai.com/profile'?: { email?: string };
}

function toSession(data: TokenReply, previous?: Session): Session {
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (!data.access_token || !refreshToken) throw new SignInError('ChatGPT returned incomplete credentials. Sign in again.');
  const access = claims(data.access_token);
  const expiresIn = data.expires_in ?? Math.max(0, (access.exp ?? 0) - Date.now() / 1000);
  // A refresh may leave out the ID token; keep what the previous session knew.
  return { ...previous, ...identity(access, claims(data.id_token)), accessToken: data.access_token, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

function identity(access: Claims, id: Claims): Partial<Session> {
  const auth = { ...id['https://api.openai.com/auth'], ...access['https://api.openai.com/auth'] };
  const found = {
    accountId: auth.chatgpt_account_id,
    residency: auth.chatgpt_data_residency ?? auth.chatgpt_compute_residency,
    email: id.email ?? access['https://api.openai.com/profile']?.email,
    plan: auth.chatgpt_plan_type,
  };
  return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined));
}

function claims(token: string | undefined): Claims {
  try {
    return JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims;
  } catch {
    return {};
  }
}
