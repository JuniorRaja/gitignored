import * as vscode from 'vscode';
import { isHidden, setHidden, reconcileExcludesOnStartup } from './toggleManager';
import { updateGitignoreDecorations, createGitignoreHover, countCache } from './patternDecorator';

export function activate(context: vscode.ExtensionContext) {
  reconcileExcludesOnStartup(context);

  const currentlyHidden = isHidden();
  vscode.commands.executeCommand('setContext', 'gitignoreToggle.hidden', currentlyHidden);

  // --- Decorations & hover ---
  const gitignoreLineDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 3em' },
    isWholeLine: true,
  });
  context.subscriptions.push(
    gitignoreLineDecoration,
    vscode.languages.registerHoverProvider({ language: 'ignore', scheme: 'file' }, {
      provideHover: (document, position) => createGitignoreHover(document, position)
    })
  );

  // --- Status bar ---
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'gitignoreToggle.toggle';
  context.subscriptions.push(statusBar);

  function updateStatusBar(hidden: boolean) {
    if (hidden) {
      statusBar.text            = '$(eye-closed) .gitignore: hidden';
      statusBar.tooltip         = 'gitignored files are hidden — click to show';
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBar.text            = '$(eye) .gitignore: visible';
      statusBar.tooltip         = 'gitignored files are visible — click to hide';
      statusBar.backgroundColor = undefined;
    }
  }

  updateStatusBar(currentlyHidden);
  statusBar.show();

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('gitignoreToggle.hide', async () => {
      await setHidden(true, context);
      updateStatusBar(true);
    }),
    vscode.commands.registerCommand('gitignoreToggle.show', async () => {
      await setHidden(false, context);
      updateStatusBar(false);
    }),
    vscode.commands.registerCommand('gitignoreToggle.toggle', async () => {
      const next = !isHidden();
      await setHidden(next, context);
      updateStatusBar(next);
    })
  );

  // --- Decoration scheduling ---
  const scheduleUpdate = (() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return (editor: vscode.TextEditor | undefined) => {
      if (!editor || editor.document.languageId !== 'ignore') { return; }
      if (timeout) { clearTimeout(timeout); }
      timeout = setTimeout(() => updateGitignoreDecorations(editor, gitignoreLineDecoration), 250);
    };
  })();

  if (vscode.window.activeTextEditor) { scheduleUpdate(vscode.window.activeTextEditor); }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => scheduleUpdate(editor)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        countCache.clear();
        scheduleUpdate(vscode.window.activeTextEditor);
      }
    })
  );

  // --- .gitignore watcher ---
  const watcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  const reapply = () => { countCache.clear(); if (isHidden()) { setHidden(true, context); } };
  watcher.onDidChange(reapply);
  watcher.onDidCreate(reapply);
  watcher.onDidDelete(reapply);
  context.subscriptions.push(watcher);
}

export function deactivate() {}
