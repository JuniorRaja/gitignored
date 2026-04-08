# .gitignored

A minimal VS Code extension that adds a single button to the Explorer toolbar to show or hide files listed in your `.gitignore`.

## Usage

| Control | Action |
|---|---|
| Explorer toolbar button | Toggle visibility |
| Status bar item (bottom-left) | Toggle visibility |
| Command Palette: `Toggle .gitignore'd Files` | Toggle visibility |

The state is saved per-workspace in `.vscode/settings.json` and restored automatically on next open.

## How it works

When **hidden**, the extension reads your root `.gitignore`, converts each pattern to a VS Code glob, and injects them into `files.exclude` in your workspace settings. When **visible**, it removes only the globs it injected — your own `files.exclude` entries are never touched.

The status bar shows the current state at a glance:

- `$(eye) .gitignore: visible` — gitignored files are shown (default)
- `$(eye-closed) .gitignore: hidden` — gitignored files are excluded from the Explorer

If `.gitignore` is modified while files are hidden, the exclude list updates automatically.

## Requirements

- An open workspace folder (single or multi-root)
- A `.gitignore` file at the root of the workspace folder

## Install (dev)

```bash
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

## Build VSIX

```bash
npm install -g @vscode/vsce
vsce package
```
