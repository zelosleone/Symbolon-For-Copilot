import * as vscode from 'vscode';
import { authorize, newHostId, PLAN_SCOPE, refresh, revoke, SessionExpiredError, SignInError, type Account } from './siwc.js';

const APP_NAME = 'Symbolon';
const STORE_KEY = 'symbolon.accounts';
const HOST_KEY = 'symbolon.hostId';
const WELCOMED_KEY = 'symbolon.welcomed';
const REFRESH_EARLY_MS = 5 * 60_000;
export const USAGE_URL = 'https://chatgpt.com/settings/usage';

type Saved = Account & { needsConsent?: boolean };

interface Store {
  active?: string;
  accounts: Record<string, Saved>;
}

export class NotSignedInError extends Error {
  constructor(message = 'Not signed in. Run "Symbolon: Continue with ChatGPT".') {
    super(message);
  }
}

export class Auth {
  private signingIn?: Promise<void>;
  private refreshing?: Promise<string>;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
  ) {}

  onDidChange(listener: () => void): vscode.Disposable {
    return this.secrets.onDidChange((event) => {
      if (event.key === STORE_KEY) listener();
    });
  }

  async current(): Promise<Saved | undefined> {
    const store = await this.read();
    const account = store.active ? store.accounts[store.active] : undefined;
    return account?.tokens ? account : undefined;
  }

  /** A valid access token for the active account, refreshed near expiry (or when forced). */
  async accessToken(force = false): Promise<string> {
    const account = await this.current();
    if (!account?.tokens) throw new NotSignedInError();
    if (!force && account.tokens.expiresAt - REFRESH_EARLY_MS > Date.now()) return account.tokens.accessToken;
    // Refresh tokens rotate, so two refreshes at once would invalidate each other.
    this.refreshing ??= this.renew(account).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async renew(account: Saved): Promise<string> {
    try {
      const renewed = await refresh(account);
      await this.save(renewed, true);
      return renewed.tokens?.accessToken as string;
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      await this.save({ ...account, tokens: undefined }, false);
      throw new NotSignedInError('Your ChatGPT session expired. Run "Symbolon: Continue with ChatGPT".');
    }
  }

  signIn(): Promise<void> {
    this.signingIn ??= this.runSignIn().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async runSignIn(): Promise<void> {
    const previous = await this.pickAccount();
    if (previous === null) return;
    try {
      const account = await this.authorizeInBrowser(previous);
      await this.finishSignIn(account);
    } catch (error) {
      if (!(error instanceof SignInError && error.code === 'cancelled')) {
        void vscode.window.showErrorMessage(`Symbolon: ${(error as Error).message}`);
      }
    }
  }

  // undefined means a new account; null means the user dismissed the picker.
  private async pickAccount(): Promise<Saved | undefined | null> {
    const saved = Object.values((await this.read()).accounts);
    if (saved.length === 0) return undefined;
    const items = [
      ...saved.map((account) => ({ label: account.email ?? account.subject, description: 'Saved account', account })),
      { label: 'Use another ChatGPT account', description: '', account: undefined },
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Continue with ChatGPT' });
    return choice ? choice.account : null;
  }

  private authorizeInBrowser(previous: Saved | undefined): Thenable<Account> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Symbolon: finish signing in to ChatGPT in your browser',
        cancellable: true,
      },
      (_progress, cancel) => {
        const abort = new AbortController();
        cancel.onCancellationRequested(() => abort.abort());
        return authorize({
          appName: APP_NAME,
          hostId: this.hostId(),
          previous,
          reconsent: previous?.needsConsent,
          // Passed as a string, VS Code opens the URL exactly as built; a parsed Uri gets its query re-encoded.
          open: (url) => vscode.env.openExternal(url as unknown as vscode.Uri),
          signal: abort.signal,
        });
      },
    );
  }

  private async finishSignIn(account: Account): Promise<void> {
    if (!account.tokens?.scopes.includes(PLAN_SCOPE)) {
      // Keep the registration so the next attempt asks for the plan permission again.
      await this.save({ ...account, tokens: undefined, needsConsent: true }, false);
      throw new SignInError('ChatGPT plan use was not allowed for Symbolon. Sign in again and allow it.');
    }
    await this.save(account, true);
    if (this.state.get(WELCOMED_KEY)) {
      void vscode.window.showInformationMessage(`Symbolon: signed in as ${account.email ?? 'your ChatGPT account'}.`);
      return;
    }
    await this.state.update(WELCOMED_KEY, true);
    await welcome();
  }

  async signOut(): Promise<void> {
    const account = await this.current();
    if (!account) return;
    const revoked = await revoke(account);
    await this.save({ ...account, tokens: undefined }, false);
    if (!revoked) {
      void vscode.window.showWarningMessage(
        'Symbolon signed out here, but ChatGPT did not confirm ending the session. You can disconnect Symbolon in ChatGPT Settings.',
      );
    }
  }

  private hostId(): string {
    // One opaque ID per installation: it stays in non-synced local state.
    let id = this.state.get<string>(HOST_KEY);
    if (!id) {
      id = newHostId();
      void this.state.update(HOST_KEY, id);
    }
    return id;
  }

  private async read(): Promise<Store> {
    const raw = await this.secrets.get(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : { accounts: {} };
  }

  private async save(account: Saved, active: boolean): Promise<void> {
    const store = await this.read();
    store.accounts[account.subject] = account;
    if (active) store.active = account.subject;
    else if (store.active === account.subject) store.active = undefined;
    await this.secrets.store(STORE_KEY, JSON.stringify(store));
  }
}

async function welcome(): Promise<void> {
  const gotIt = { title: 'Got it', isCloseAffordance: true };
  const manage = { title: 'Manage usage' };
  const choice = await vscode.window.showInformationMessage(
    "You're using your ChatGPT plan",
    {
      modal: true,
      detail:
        'Requests Symbolon sends from Copilot Chat count toward your ChatGPT plan. You can review usage and set a limit for Symbolon in ChatGPT settings.',
    },
    gotIt,
    manage,
  );
  if (choice === manage) await vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
}
