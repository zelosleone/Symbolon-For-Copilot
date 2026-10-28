// Real VS Code smoke test (--extensionTestsPath): activation, commands, provider, sign-in URL.
const vscode = require('vscode');
const fs = require('node:fs');

exports.run = async function run() {
  const out = process.env.SYMBOLON_SMOKE_OUT;
  const result = {};
  try {
    const ext = vscode.extensions.getExtension('DenizhanDaklr.symbolon-for-copilot');
    await ext.activate();
    result.active = ext.isActive;
    const commands = await vscode.commands.getCommands(true);
    result.commands = commands.filter((c) => c.startsWith('symbolon.'));
    result.models = (await vscode.lm.selectChatModels({ vendor: 'symbolon' })).length;
    void vscode.commands.executeCommand('symbolon.signIn');
    await new Promise((r) => setTimeout(r, 6000));
  } catch (error) {
    result.error = String(error && error.stack || error);
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
};
