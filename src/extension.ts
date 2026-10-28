import * as vscode from 'vscode';
import { Auth, USAGE_URL } from './auth.js';
import { scheduleLodestarNotice } from './lodestar.js';
import { SymbolonProvider } from './provider.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Symbolon', { log: true });
  const auth = new Auth(context.secrets, context.globalState);
  const provider = new SymbolonProvider(context.globalState, auth, log);
  const timer = setInterval(() => void provider.refresh(), REFRESH_INTERVAL_MS);
  let active: string | undefined;
  const onAuthChange = async (): Promise<void> => {
    // Token refreshes rewrite the store too; only an account switch changes the model list.
    const subject = (await auth.current())?.subject;
    if (subject === active) return;
    active = subject;
    provider.accountChanged();
  };

  context.subscriptions.push(
    log,
    new vscode.Disposable(() => clearInterval(timer)),
    vscode.lm.registerLanguageModelChatProvider('symbolon', provider),
    auth.onDidChange(() => void onAuthChange()),
    vscode.commands.registerCommand('symbolon.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('symbolon.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('symbolon.manage', () => manage(auth, provider, log)),
  );
  void onAuthChange();
  scheduleLodestarNotice(context);
}

async function manage(auth: Auth, provider: SymbolonProvider, log: vscode.LogOutputChannel): Promise<void> {
  const account = await auth.current();
  const actions: Record<string, () => unknown> = account
    ? {
        'Manage usage': () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL)),
        'Refresh models': () => provider.refresh(),
        'Switch account': () => auth.signIn(),
        'Sign out': () => auth.signOut(),
      }
    : { 'Continue with ChatGPT': () => auth.signIn() };
  actions['Show logs'] = () => log.show();
  const title = account ? `Symbolon: using ChatGPT plan of ${account.email ?? 'your account'}` : 'Symbolon: signed out';
  const choice = await vscode.window.showQuickPick(Object.keys(actions), { title });
  if (choice) await actions[choice]();
}
