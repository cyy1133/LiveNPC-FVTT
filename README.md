# FVTT AI NPC Runtime (WIP)

Standalone desktop runtime (Electron) that connects FVTT <-> Discord <-> LLM without OpenClaw.

## Run (dev)

```powershell
cd fvtt-ai-runtime
npm.cmd install
npm.cmd start
```

## Recommended provider

- `codex-cli` (ChatGPT subscription flow)
- No API key required
- First-run setup can auto-install prerequisites from GUI (`Install Prerequisites`)
- Login via GUI button (`Codex Login`) or CLI command (`codex-login`)

## Config

- GUI writes to app config (`config.json` under app data)
- `config.example.json` shows full schema
- MVP note: secrets are currently stored in config file

## CLI (optional)

```powershell
cd fvtt-ai-runtime
node runtime/cli.js setup --config .\config.json
node runtime/cli.js codex-login --config .\config.json
node runtime/cli.js diagnose --config .\config.json
node runtime/cli.js run --config .\config.json
```

## Build installer

```powershell
cd fvtt-ai-runtime
npm.cmd run dist
```

Output:

- `fvtt-ai-runtime/dist/FVTT AI NPC Runtime Setup 0.1.0.exe`
