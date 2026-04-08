# .gitignored

A minimal VS Code extension that adds a single button to the Explorer toolbar to show or hide files listed in your `.gitignore`.

![Toggle demo](resources/gitignored-toggle-demo.gif)

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

![Status bar demo](resources/gitignored-status-demo.gif)

- `$(eye) .gitignore: visible` — gitignored files are shown (default)
- `$(eye-closed) .gitignore: hidden` — gitignored files are excluded from the Explorer

If `.gitignore` is modified while files are hidden, the exclude list updates automatically.

## Requirements

- An open workspace folder (single or multi-root)
- A `.gitignore` file at the root of the workspace folder

## Known Limitations

- Negation patterns (`!pattern`) in `.gitignore` are not supported — VS Code's `files.exclude` has no way to express them
- Only reads the root `.gitignore`; nested `.gitignore` files in subdirectories are not picked up

## Contributing

Contributions are welcome! To get started:

```bash
git clone https://github.com/juniorraja/gitignored.git
cd gitignored
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host and test your changes.

To build a VSIX locally:

```bash
npm install -g @vscode/vsce
vsce package
```

Feel free to open an [issue](https://github.com/juniorraja/gitignored/issues) or submit a pull request.

## License

[MIT](LICENSE)
