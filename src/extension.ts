import * as vscode from 'vscode';
import { Auth, USAGE_URL } from './auth.js';
import { identify } from './chatgpt.js';
import { scheduleLodestarNotice } from './lodestar.js';
import { SymbolonProvider } from './provider.js';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  identify('Symbolon', (context.extension.packageJSON as { version: string }).version);
  const log = vscode.window.createOutputChannel('Symbolon', { log: true });
  const auth = new Auth(context.secrets);
  const provider = new SymbolonProvider(context.globalState, auth, log);
  const timer = setInterval(() => void provider.refresh(), REFRESH_INTERVAL_MS);
  let account: string | undefined;
  const onAuthChange = async (): Promise<void> => {
    // Token refreshes rewrite the session too; only a different account changes the model list.
    const current = (await auth.current())?.accountId ?? '';
    if (current === account) return;
    account = current;
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
  const session = await auth.current();
  const actions: Record<string, () => unknown> = session
    ? {
        'Usage limits': () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL)),
        'Refresh models': () => provider.refresh(),
        'Sign in with another account': () => auth.signIn(),
        'Sign out': () => auth.signOut(),
      }
    : { 'Sign in with ChatGPT': () => auth.signIn() };
  actions['Show logs'] = () => log.show();
  const plan = session?.plan ? ` (${session.plan})` : '';
  const title = session ? `Symbolon: signed in as ${session.email ?? 'your ChatGPT account'}${plan}` : 'Symbolon: signed out';
  const choice = await vscode.window.showQuickPick(Object.keys(actions), { title });
  if (choice) await actions[choice]();
}
