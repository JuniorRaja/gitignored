import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Key used in workspaceState to track which globs this extension injected into
// files.exclude, so they can be removed cleanly on toggle-off or startup.
const STORAGE_KEY = 'gitignoreToggle.excludedGlobs';

const gitignoreLineDecoration = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 3em',
  },
  isWholeLine: true,
});

// ---------------------------------------------------------------------------
// .gitignore parser
// ---------------------------------------------------------------------------

/**
 * Reads the root .gitignore of a workspace folder and converts each pattern
 * to a glob that VS Code's files.exclude setting understands.
 *
 * Normalisation rules:
 *   /dist      → dist          (root-anchored: strip leading slash)
 *   *.log      → **∕*.log      (no slash → match anywhere in tree)
 *   dist/      → dist          (trailing slash means "dir only"; drop it —
 *                               files.exclude matches dirs by name anyway)
 *   !keep.log  → skipped       (negation patterns are not supported by files.exclude)
 *   # comment  → skipped
 */
function parseGitignore(root: string): string[] {
  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) { return []; }

  return fs.readFileSync(gitignorePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => {
      l = l.replace(/\/$/, '');                    // dist/  → dist
      if (l.startsWith('/')) { return l.slice(1); } // /dist  → dist
      if (!l.includes('/')) { return `**/${l}`; }   // *.log  → **/*.log
      return l;
    });
}

function describeGitignorePattern(line: string): string {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) { return ''; }

  const isNegation = raw.startsWith('!');
  const original = isNegation ? raw.slice(1) : raw;
  const anchored = original.startsWith('/');
  const directoryOnly = original.endsWith('/');
  const body = original.replace(/^\//, '').replace(/\/$/, '');
  const isGlob = /[*?\[]/.test(body);
  const hasSlash = body.includes('/');

  const sentences: string[] = [];
  if (isNegation) {
    sentences.push(`Negation: re-includes \`${body}\` even if a previous rule excluded it.`);
  }

  if (directoryOnly) {
    if (!body) {
      sentences.push('Directory-only pattern that applies to the repository root.');
    } else if (anchored) {
      sentences.push(`Matches the directory \`${body}\` at the repository root and all files inside it.`);
    } else if (hasSlash) {
      sentences.push(`Matches directories named like \`${body}\` at any depth and their contents.`);
    } else {
      sentences.push(`Matches directories named \`${body}\` at any depth and all files under them.`);
    }
  } else {
    if (!hasSlash) {
      if (isGlob) {
        sentences.push(`Matches filenames like \`${body}\` anywhere in the repository.`);
      } else if (anchored) {
        sentences.push(`Matches the file or directory \`${body}\` only at the repository root.`);
      } else {
        sentences.push(`Matches any file or directory named \`${body}\` anywhere in the repository.`);
      }
    } else {
      if (anchored) {
        sentences.push(`Matches paths under the repository root like \`${body}\`.`);
      } else {
        sentences.push(`Matches paths like \`${body}\` at any depth inside the repository.`);
      }
    }
  }

  const details: string[] = [];
  if (anchored) {
    details.push('Root-anchored: only matches paths from the repository root.');
  }
  if (directoryOnly) {
    details.push('Directory-only: applies to folders and their contents.');
  }
  if (body.includes('**')) {
    details.push('`**` matches across directory boundaries at any depth.');
  }
  if (body.includes('*') && !body.includes('**')) {
    details.push('`*` matches any string except path separators.');
  }
  if (body.includes('?')) {
    details.push('`?` matches exactly one character.');
  }
  if (body.includes('[')) {
    details.push('Character classes like `[abc]` match any one of the listed characters.');
  }

  return sentences.join(' ') + (details.length ? '\n\n' + details.map(d => `- ${d}`).join('\n') : '');
}

function patternLineToSearchGlobs(line: string): string[] {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) { return []; }

  const isNegation = raw.startsWith('!');
  let pattern = isNegation ? raw.slice(1) : raw;
  const anchored = pattern.startsWith('/');
  const directoryOnly = pattern.endsWith('/');
  pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
  if (!pattern) { return ['**/*']; }

  const hasGlob = /[*?\[]/.test(pattern);
  const globs: string[] = [];

  if (directoryOnly) {
    if (anchored) {
      globs.push(`${pattern}/**`);
    } else {
      globs.push(`**/${pattern}/**`);
    }
    return globs;
  }

  if (!hasGlob && !pattern.includes('/')) {
    if (anchored) {
      globs.push(pattern);
      globs.push(`${pattern}/**`);
    } else {
      globs.push(`**/${pattern}`);
    }
    return globs;
  }

  if (anchored) {
    globs.push(pattern);
  } else {
    globs.push(`**/${pattern}`);
  }

  return globs;
}

async function resolvePatternMatches(line: string, limit = 1000): Promise<string[]> {
  const globs = patternLineToSearchGlobs(line);
  if (globs.length === 0) { return []; }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { return []; }

  const found = new Set<string>();
  for (const folder of folders) {
    for (const glob of globs) {
      const relative = new vscode.RelativePattern(folder, glob);
      const matches = await vscode.workspace.findFiles(relative, undefined, limit - found.size + 1);
      for (const uri of matches) {
        found.add(vscode.workspace.asRelativePath(uri, false));
        if (found.size >= limit) { break; }
      }
      if (found.size >= limit) { break; }
    }
    if (found.size >= limit) { break; }
  }

  return [...found];
}

async function countPatternMatches(line: string): Promise<number> {
  return (await resolvePatternMatches(line, 1000)).length;
}

async function updateGitignoreDecorations(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (document.languageId !== 'ignore') { return; }

  const countCache = new Map<string, number>();
  const decorations: vscode.DecorationOptions[] = [];

  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const text = line.text.trim();
    if (!text || text.startsWith('#')) { continue; }

    let matchCount = countCache.get(text);
    if (matchCount === undefined) {
      matchCount = await countPatternMatches(text);
      countCache.set(text, matchCount);
    }

    const label = matchCount === 0
      ? '⟵ ⚠ no matches'
      : `⟵ ${matchCount === 1000 ? '1000+' : matchCount} file${matchCount === 1 ? '' : 's'}`;

    decorations.push({
      range: line.range,
      renderOptions: {
        after: {
          contentText: label,
        }
      }
    });
  }

  editor.setDecorations(gitignoreLineDecoration, decorations);
}

async function createGitignoreHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
  const lineText = document.lineAt(position.line).text.trim();
  if (!lineText || lineText.startsWith('#')) { return null; }

  const description = describeGitignorePattern(lineText);
  if (!description) { return null; }

  const matchCount = await countPatternMatches(lineText);
  const countText = matchCount === 0
    ? 'No matching files found.'
    : `${matchCount === 1000 ? '1000+' : matchCount} file${matchCount === 1 ? '' : 's'} match this pattern.`;

  const contents = new vscode.MarkdownString();
  contents.appendMarkdown(`**Pattern:** \`${lineText}\``);
  contents.appendMarkdown(`\n\n${description}`);
  contents.appendMarkdown(`\n\n**Workspace match count:** ${countText}`);
  contents.isTrusted = false;

  return new vscode.Hover(contents, document.lineAt(position.line).range);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Reads the persisted hidden flag from workspace settings. */
function isHidden(): boolean {
  return vscode.workspace
    .getConfiguration('gitignoreToggle')
    .get<boolean>('hidden', false);
}

// ---------------------------------------------------------------------------
// Startup desync guard
// ---------------------------------------------------------------------------

/**
 * Heals a mismatch between workspaceState and files.exclude that can occur
 * when workspaceState is wiped (e.g. after a VS Code reinstall or storage
 * corruption) while the injected globs are still sitting in
 * .vscode/settings.json.
 *
 * If hidden=false but the stored glob list is non-empty, those globs were
 * never cleaned up — remove them now before the user interacts with anything.
 */
async function reconcileExcludesOnStartup(context: vscode.ExtensionContext): Promise<void> {
  const stored: string[] = context.workspaceState.get(STORAGE_KEY, []);
  if (stored.length === 0) { return; } // nothing was ever injected
  if (isHidden()) { return; }          // globs should be present — leave them

  const filesConfig = vscode.workspace.getConfiguration('files');
  const current: Record<string, boolean> = { ...(filesConfig.get('exclude') ?? {}) };

  let changed = false;
  for (const g of stored) {
    if (Object.prototype.hasOwnProperty.call(current, g)) {
      delete current[g];
      changed = true;
    }
  }

  if (changed) {
    try {
      await filesConfig.update('exclude', current, vscode.ConfigurationTarget.Workspace);
    } catch {
      // Non-fatal — workspace may be read-only.
      vscode.window.showWarningMessage(
        'gitignore Toggle: could not clean up stale exclude entries from a previous session.'
      );
    }
  }

  // Always clear storage so this reconciliation doesn't repeat next startup.
  await context.workspaceState.update(STORAGE_KEY, []);
}

// ---------------------------------------------------------------------------
// Core toggle logic
// ---------------------------------------------------------------------------

/**
 * Applies or removes the gitignore-derived globs from files.exclude.
 *
 * Write order matters for safety:
 *   1. Update workspaceState first — if the settings write later fails,
 *      reconcileExcludesOnStartup will clean up on the next launch.
 *   2. Write files.exclude and the hidden flag together; roll back
 *      workspaceState if either write throws.
 */
async function setHidden(hidden: boolean, context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    vscode.window.showWarningMessage('gitignore Toggle requires an open workspace folder.');
    return;
  }

  const filesConfig = vscode.workspace.getConfiguration('files');
  const current: Record<string, boolean> = { ...(filesConfig.get('exclude') ?? {}) };

  // Strip whatever we previously injected so we start from a clean slate.
  const prev: string[] = context.workspaceState.get(STORAGE_KEY, []);
  for (const g of prev) { delete current[g]; }

  // Build the new exclude map (empty when toggling back to visible).
  const next = new Set<string>();
  if (hidden) {
    for (const folder of folders) {
      for (const g of parseGitignore(folder.uri.fsPath)) {
        current[g] = true;
        next.add(g); // Set deduplicates patterns shared across workspace folders
      }
    }
  }

  // Persist the new list before writing to files.exclude (crash-safe ordering).
  await context.workspaceState.update(STORAGE_KEY, [...next]);

  try {
    await filesConfig.update('exclude', current, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('gitignoreToggle')
      .update('hidden', hidden, vscode.ConfigurationTarget.Workspace);
    // Sync the context key so the toolbar icon when-clause updates immediately.
    await vscode.commands.executeCommand('setContext', 'gitignoreToggle.hidden', hidden);
  } catch (err) {
    // Restore workspaceState to match the unchanged files.exclude.
    await context.workspaceState.update(STORAGE_KEY, prev);
    vscode.window.showErrorMessage(
      `gitignore Toggle: failed to update settings — ${err instanceof Error ? err.message : err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  // Heal any desync left over from a previous session before doing anything else.
  reconcileExcludesOnStartup(context);

  // Restore the context key so the correct toolbar icon appears immediately
  // on startup without the user needing to interact first.
  const currentlyHidden = isHidden();
  vscode.commands.executeCommand('setContext', 'gitignoreToggle.hidden', currentlyHidden);

  // --- .gitignore hover help -------------------------------------------
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: 'ignore', scheme: 'file' }, {
      provideHover: (document, position) => createGitignoreHover(document, position)
    })
  );
  context.subscriptions.push(gitignoreLineDecoration);

  // --- Status bar -------------------------------------------------------
  // Provides a persistent, always-visible indicator of the current state.
  // Yellow background when hidden so it catches attention without an extra panel.
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

  // --- Commands ---------------------------------------------------------
  // Two directional commands drive the toolbar icon swap:
  //   hide — visible in the toolbar only when files are currently shown
  //   show — visible in the toolbar only when files are currently hidden
  // Both are excluded from the Command Palette (see package.json menus.commandPalette).
  //
  // A third "toggle" command is registered for Command Palette use and the
  // status bar click, where the current state is determined at call time.
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

  const scheduleUpdate = (() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return (editor: vscode.TextEditor | undefined) => {
      if (!editor || editor.document.languageId !== 'ignore') { return; }
      if (timeout) { clearTimeout(timeout); }
      timeout = setTimeout(() => updateGitignoreDecorations(editor), 250);
    };
  })();

  if (vscode.window.activeTextEditor) {
    scheduleUpdate(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => scheduleUpdate(editor)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        scheduleUpdate(vscode.window.activeTextEditor);
      }
    })
  );

  // --- .gitignore watcher -----------------------------------------------
  // Re-applies the exclude list whenever .gitignore changes on disk while
  // hidden mode is active, so the Explorer stays in sync without a manual toggle.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  const reapply = () => { if (isHidden()) { setHidden(true, context); } };
  watcher.onDidChange(reapply);
  watcher.onDidCreate(reapply);
  watcher.onDidDelete(reapply);
  context.subscriptions.push(watcher);
}

export function deactivate() {}
