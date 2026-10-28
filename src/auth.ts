import * as vscode from 'vscode';
import { authorize, refresh, revoke, SessionExpiredError, SignInError, type Session } from './chatgpt.js';

const SESSION_KEY = 'symbolon.session';
const REFRESH_EARLY_MS = 5 * 60_000;
export const USAGE_URL = 'https://chatgpt.com/codex/settings/usage';

export class NotSignedInError extends Error {
  constructor(message = 'Not signed in. Run "Symbolon: Sign In with ChatGPT".') {
    super(message);
  }
}

export class Auth {
  private signingIn?: Promise<void>;
  private refreshing?: Promise<Session>;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key === SESSION_KEY) listener();
    });
  }

  async current(): Promise<Session | undefined> {
    const stored = await this.secrets.get(SESSION_KEY);
    return stored ? (JSON.parse(stored) as Session) : undefined;
  }

  /** The session with a valid access token, refreshed near expiry (or when forced). */
  async session(force = false): Promise<Session> {
    const session = await this.current();
    if (!session) throw new NotSignedInError();
    if (!force && session.expiresAt - REFRESH_EARLY_MS > Date.now()) return session;
    // Refresh tokens are single-use, so two refreshes at once would revoke the session.
    this.refreshing ??= this.renew(session).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async renew(session: Session): Promise<Session> {
    try {
      const renewed = await refresh(session);
      await this.secrets.store(SESSION_KEY, JSON.stringify(renewed));
      return renewed;
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      await this.secrets.delete(SESSION_KEY);
      throw new NotSignedInError('Your ChatGPT session expired. Run "Symbolon: Sign In with ChatGPT".');
    }
  }

  signIn(): Promise<void> {
    this.signingIn ??= this.runSignIn().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async runSignIn(): Promise<void> {
    try {
      const session = await this.authorizeInBrowser();
      await this.secrets.store(SESSION_KEY, JSON.stringify(session));
      void vscode.window.showInformationMessage(`Symbolon: signed in as ${session.email ?? 'your ChatGPT account'}.`);
    } catch (error) {
      if (!(error instanceof SignInError && error.code === 'cancelled')) {
        void vscode.window.showErrorMessage(`Symbolon: ${(error as Error).message}`);
      }
    }
  }

  private authorizeInBrowser(): Thenable<Session> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Symbolon: finish signing in to ChatGPT in your browser', cancellable: true },
      (_progress, cancel) => {
        const abort = new AbortController();
        cancel.onCancellationRequested(() => abort.abort());
        // Passed as a string, VS Code opens the URL exactly as built; a parsed Uri gets its query re-encoded.
        return authorize((url) => vscode.env.openExternal(url as unknown as vscode.Uri), abort.signal);
      },
    );
  }

  async signOut(): Promise<void> {
    const session = await this.current();
    if (!session) return;
    await this.secrets.delete(SESSION_KEY);
    if (!(await revoke(session))) {
      void vscode.window.showWarningMessage('Symbolon signed out here, but OpenAI did not confirm ending the session.');
    }
  }
}
