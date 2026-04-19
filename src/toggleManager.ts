import * as vscode from 'vscode';
import { parseGitignore } from './gitignoreParser';

const STORAGE_KEY = 'gitignoreToggle.excludedGlobs';

export function isHidden(): boolean {
  return vscode.workspace.getConfiguration('gitignoreToggle').get<boolean>('hidden', false);
}

export async function reconcileExcludesOnStartup(context: vscode.ExtensionContext): Promise<void> {
  const stored: string[] = context.workspaceState.get(STORAGE_KEY, []);
  if (stored.length === 0) { return; }
  if (isHidden()) { return; }

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
      vscode.window.showWarningMessage(
        'gitignore Toggle: could not clean up stale exclude entries from a previous session.'
      );
    }
  }

  await context.workspaceState.update(STORAGE_KEY, []);
}

export async function setHidden(hidden: boolean, context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    vscode.window.showWarningMessage('gitignore Toggle requires an open workspace folder.');
    return;
  }

  const filesConfig = vscode.workspace.getConfiguration('files');
  const current: Record<string, boolean> = { ...(filesConfig.get('exclude') ?? {}) };

  const prev: string[] = context.workspaceState.get(STORAGE_KEY, []);
  for (const g of prev) { delete current[g]; }

  const next = new Set<string>();
  if (hidden) {
    for (const folder of folders) {
      for (const g of parseGitignore(folder.uri.fsPath)) {
        current[g] = true;
        next.add(g);
      }
    }
  }

  await context.workspaceState.update(STORAGE_KEY, [...next]);

  try {
    await filesConfig.update('exclude', current, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('gitignoreToggle')
      .update('hidden', hidden, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('setContext', 'gitignoreToggle.hidden', hidden);
  } catch (err) {
    await context.workspaceState.update(STORAGE_KEY, prev);
    vscode.window.showErrorMessage(
      `gitignore Toggle: failed to update settings — ${err instanceof Error ? err.message : err}`
    );
  }
}
