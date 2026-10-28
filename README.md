# Symbolon for Copilot

Use your ChatGPT plan in GitHub Copilot Chat through OpenAI's Sign in with ChatGPT. No API key needed.

> Also from the same developer: [Lodestar](https://marketplace.visualstudio.com/items?itemName=DenizhanDaklr.lodestar) walks you through how code works, explains anything you hover, and reviews your changes on any model in VS Code, including this extension's. 3 free runs included, then $5 one-time.

1. Run **Symbolon: Continue with ChatGPT** and allow Symbolon to use your ChatGPT plan in the browser.
2. Pick a model in the Copilot Chat model picker.
3. Set its reasoning effort and speed right in the picker.

Models come from your account's own catalog, in the same format as Codex's `models.json`, with Codex's published `models.json` as the fallback. Context windows, reasoning efforts, speed tiers and image support all come from it, so new models show up without an update. Reasoning carries over between turns, and Copilot's context window indicator and prompt caching work as usual.

ChatGPT shares Plus and Pro plans with apps like this one. Workspace admins can turn third-party access off for Business and Enterprise accounts. Requests count toward your plan, and you can see Symbolon's usage and cap it in [ChatGPT settings](https://chatgpt.com/settings/usage). Only Copilot Chat can use these models; other extensions can't spend your plan.

**Symbolon: Manage** shows the connected account and lets you manage usage, refresh models, switch accounts, sign out or open the logs. Signing out ends the session with OpenAI.

## Development

```sh
npm install
npm run compile
npm run lint      # includes a complexity cap of 8
npx -y knip       # unused files, exports and dependencies
node --import ./test/register.mjs test/e2e.mjs path/to/models.json   # end-to-end run against a mocked OpenAI
npm run package   # builds the .vsix
```

Unofficial, not affiliated with or endorsed by OpenAI. ChatGPT and Codex are trademarks of OpenAI.
