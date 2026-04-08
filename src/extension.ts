import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Key used in workspaceState to track which globs this extension injected into
// files.exclude, so they can be removed cleanly on toggle-off or startup.
const STORAGE_KEY = 'gitignoreToggle.excludedGlobs';

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
