// Resolves `import 'vscode'` to the stub: node --import ./test/register.mjs ...
export async function resolve(specifier, context, next) {
  if (specifier === 'vscode') return { url: new URL('./vscode-stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
