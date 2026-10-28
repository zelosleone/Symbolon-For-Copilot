import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Sign in with ChatGPT for open-source apps: https://developers.openai.com/siwc/token-sharing-open-source
const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const NEW_CLIENT = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const UNUSABLE_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

/** One registration: the issued client is bound to this ChatGPT account and workspace. */
export interface Account {
  subject: string;
  clientId: string;
  email?: string;
  tokens?: Tokens;
}

export interface AuthorizeOptions {
  appName: string;
  hostId: string;
  previous?: Account;
  reconsent?: boolean;
  scopes?: string;
  open: (url: string) => PromiseLike<unknown>;
  signal: AbortSignal;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

interface Callback {
  code: string;
  clientId: string;
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

let discovery: Promise<Discovery> | undefined;

function getDiscovery(): Promise<Discovery> {
  discovery ??= loadDiscovery().catch((error: unknown) => {
    discovery = undefined;
    throw error;
  });
  return discovery;
}

async function loadDiscovery(): Promise<Discovery> {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json()) as Discovery;
  if (!res.ok || body.issuer !== ISSUER) throw new SignInError('ChatGPT sign-in configuration could not be verified.');
  return body;
}

const random = (): string => randomBytes(32).toString('base64url');

export function newHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export async function authorize(options: AuthorizeOptions): Promise<Account> {
  const state = random();
  const nonce = random();
  const verifier = random();
  const provider = await getDiscovery();
  const listener = await listen(state, options.previous?.clientId, options.signal);
  try {
    await options.open(authorizeUrl(provider, options, listener.redirectUri, state, nonce, verifier));
    const callback = await listener.result;
    const data = await tokenRequest(provider, {
      grant_type: 'authorization_code',
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      resource: RESOURCE,
    });
    return await toAccount(provider, data, callback.clientId, nonce, options.previous);
  } finally {
    listener.close();
  }
}

function authorizeUrl(
  provider: Discovery,
  options: AuthorizeOptions,
  redirectUri: string,
  state: string,
  nonce: string,
  verifier: string,
): string {
  const { previous } = options;
  const params: Record<string, string> = {
    client_id: previous?.clientId ?? NEW_CLIENT,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: options.scopes ?? SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ext_agent_host_id: options.hostId,
  };
  // The name hint belongs only to first-time registration; returning accounts reuse their client.
  if (!previous) params.agent_name_hint = options.appName;
  if (previous?.email) params.login_hint = previous.email;
  if (options.reconsent) params.prompt = 'consent';
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `${provider.authorization_endpoint}?${query.join('&')}`;
}

async function toAccount(
  provider: Discovery,
  data: TokenReply,
  clientId: string,
  nonce: string,
  previous: Account | undefined,
): Promise<Account> {
  if (typeof data.id_token !== 'string') throw new SignInError('ChatGPT did not return a verifiable identity.');
  const identity = await verifyIdToken(provider, data.id_token, clientId, nonce);
  if (previous?.subject && identity.subject !== previous.subject) {
    throw new SignInError('That sign-in returned a different ChatGPT account. Choose the original account.');
  }
  return { ...identity, clientId, tokens: toTokens(data) };
}

interface Listener {
  redirectUri: string;
  result: Promise<Callback>;
  close: () => void;
}

async function listen(state: string, savedClientId: string | undefined, signal: AbortSignal): Promise<Listener> {
  let settle!: (value: Callback | Error) => void;
  const result = new Promise<Callback>((resolve, reject) => {
    settle = (value) => (value instanceof Error ? reject(value) : resolve(value));
  });
  void result.catch(() => undefined);
  const server = createServer((req, res) => onCallback(req, res, state, savedClientId, settle));
  const timer = setTimeout(() => settle(new SignInError('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS);
  const abort = (): void => settle(new SignInError('Sign-in was cancelled.', 'cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const close = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    server.close();
    server.closeAllConnections();
  };
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close };
}

function onCallback(
  req: IncomingMessage,
  res: ServerResponse,
  state: string,
  savedClientId: string | undefined,
  settle: (value: Callback | Error) => void,
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end('Not found');
    return;
  }
  // Unrelated loopback requests must not consume the pending sign-in.
  if (!sameSecret(url.searchParams.get('state') ?? '', state)) {
    res.writeHead(400).end('Invalid sign-in state. Return to the browser tab that started sign-in.');
    return;
  }
  const outcome = readCallback(url, savedClientId);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page(outcome instanceof Error ? outcome.message : 'You can close this tab and return to VS Code.'));
  settle(outcome);
}

function readCallback(url: URL, savedClientId: string | undefined): Callback | Error {
  const error = url.searchParams.get('error');
  if (error) return callbackError(error, url.searchParams.get('error_description'));
  const code = url.searchParams.get('code');
  const clientId = issuedClient(url.searchParams.get('client_id'), savedClientId);
  if (clientId instanceof Error) return clientId;
  if (!code || clientId === NEW_CLIENT) return new SignInError('ChatGPT did not finish registering the app. Sign in again.');
  return { code, clientId };
}

// A returning sign-in may omit the client ID, but must never switch to another one.
function issuedClient(returned: string | null, saved: string | undefined): string | Error {
  if (returned && saved && returned !== saved) return new SignInError('ChatGPT returned a different app registration. Sign in again.');
  return returned ?? saved ?? NEW_CLIENT;
}

function callbackError(error: string, description: string | null): SignInError {
  if (error === 'access_denied') return new SignInError('ChatGPT sign-in was declined in the browser.', error);
  return new SignInError(description ?? `ChatGPT sign-in failed: ${error}.`, error);
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
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(provider: Discovery, params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch(provider.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenReply;
  if (res.ok) return data;
  throw tokenError(data, res.status, params.grant_type === 'refresh_token');
}

function tokenError(data: TokenReply, status: number, refreshing: boolean): SignInError {
  const code = data.error ?? `http_${status}`;
  const detail = data.error_description ?? (code === 'invalid_grant' ? 'ChatGPT only shares Plus and Pro plans, and workspace admins can block it.' : '');
  const message = `ChatGPT sign-in failed (${code}). ${detail}`.trim();
  return refreshing && UNUSABLE_REFRESH.has(code) ? new SessionExpiredError(message, code) : new SignInError(message, code);
}

function toTokens(data: TokenReply, previous?: Tokens): Tokens {
  // A refresh may omit scope when the grant is unchanged.
  const merged = { refresh_token: previous?.refreshToken, scope: previous?.scopes.join(' '), expires_in: 3600, ...data };
  if (!merged.access_token || !merged.refresh_token) throw new SignInError('ChatGPT returned incomplete credentials. Sign in again.');
  return {
    accessToken: merged.access_token,
    refreshToken: merged.refresh_token,
    expiresAt: Date.now() + merged.expires_in * 1000,
    scopes: (merged.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

export async function refresh(account: Account): Promise<Account> {
  if (!account.tokens) throw new SessionExpiredError('Not signed in.');
  const provider = await getDiscovery();
  const data = await tokenRequest(provider, {
    grant_type: 'refresh_token',
    client_id: account.clientId,
    refresh_token: account.tokens.refreshToken,
    resource: RESOURCE,
  });
  if (data.id_token) {
    const identity = await verifyIdToken(provider, data.id_token, account.clientId);
    if (identity.subject !== account.subject) throw new SessionExpiredError('The refreshed ChatGPT identity changed.');
  }
  return { ...account, tokens: toTokens(data, account.tokens) };
}

/** Ends the renewable session. Returns false when remote revocation could not be confirmed. */
export async function revoke(account: Account): Promise<boolean> {
  const token = account.tokens?.refreshToken;
  if (!token) return true;
  try {
    const { revocation_endpoint: endpoint } = await getDiscovery();
    if (!endpoint) return false;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: account.clientId }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

interface IdClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  sub?: string;
  nonce?: string;
  email?: string;
}

async function verifyIdToken(
  provider: Discovery,
  idToken: string,
  clientId: string,
  nonce?: string,
): Promise<{ subject: string; email?: string }> {
  const [head = '', body = '', signature = ''] = idToken.split('.');
  const header = decode<{ alg?: string; kid?: string }>(head);
  const key = await signingKey(provider, header.kid);
  const signed = header.alg === 'RS256' && verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'));
  const claims = decode<IdClaims>(body);
  if (!signed || !validClaims(claims, provider.issuer, clientId, nonce)) {
    throw new SignInError('The ChatGPT identity could not be verified. Sign in again.');
  }
  return { subject: claims.sub as string, email: claims.email };
}

function validClaims(claims: IdClaims, issuer: string, clientId: string, nonce?: string): boolean {
  const audiences = [claims.aud].flat();
  return [
    claims.iss === issuer,
    audiences.includes(clientId),
    [undefined, clientId].includes(claims.azp),
    Number(claims.exp) * 1000 > Date.now() - 5_000,
    typeof claims.sub === 'string' && claims.sub.length > 0,
    nonce === undefined || claims.nonce === nonce,
  ].every(Boolean);
}

async function signingKey(provider: Discovery, kid: string | undefined) {
  const res = await fetch(provider.jwks_uri, { signal: AbortSignal.timeout(15_000) });
  const { keys = [] } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const jwk = keys.find((key) => key.kid === kid) ?? (kid === undefined ? keys[0] : undefined);
  if (!jwk) throw new SignInError('ChatGPT identity keys are unavailable. Try again shortly.');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function decode<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return {} as T;
  }
}
