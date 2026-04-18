import * as vscode from 'vscode';
import { parsePattern } from './gitignoreParser';

export const countCache = new Map<string, number>();

function describeGitignorePattern(line: string): string {
  const p = parsePattern(line);
  if (!p) { return ''; }
  const { isNegation, anchored, directoryOnly, body, isGlob, hasSlash } = p;

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
  if (anchored) { details.push('Root-anchored: only matches paths from the repository root.'); }
  if (directoryOnly) { details.push('Directory-only: applies to folders and their contents.'); }
  if (body.includes('**')) { details.push('`**` matches across directory boundaries at any depth.'); }
  if (body.includes('*') && !body.includes('**')) { details.push('`*` matches any string except path separators.'); }
  if (body.includes('?')) { details.push('`?` matches exactly one character.'); }
  if (body.includes('[')) { details.push('Character classes like `[abc]` match any one of the listed characters.'); }

  return sentences.join(' ') + (details.length ? '\n\n' + details.map(d => `- ${d}`).join('\n') : '');
}

function patternLineToSearchGlobs(line: string): string[] {
  const p = parsePattern(line);
  if (!p) { return []; }
  const { anchored, directoryOnly, body, isGlob } = p;
  if (!body) { return []; }

  if (directoryOnly) {
    // directory-only: count files inside the directory
    return anchored ? [`${body}/**`] : [`**/${body}/**`];
  }
  if (!isGlob && !body.includes('/')) {
    // plain name: could be a file OR a directory — include both
    return anchored
      ? [body, `${body}/**`]
      : [`**/${body}`, `**/${body}/**`];
  }
  return anchored ? [body] : [`**/${body}`];
}

async function resolvePatternMatches(line: string, limit = 1000): Promise<string[]> {
  const globs = patternLineToSearchGlobs(line);
  if (globs.length === 0) { return []; }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) { return []; }

  const found = new Set<string>();
  for (const folder of folders) {
    for (const glob of globs) {
      const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), undefined, limit - found.size + 1);
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
  const cached = countCache.get(line);
  if (cached !== undefined) { return cached; }
  const count = (await resolvePatternMatches(line, 1000)).length;
  countCache.set(line, count);
  return count;
}

function makeDecoration(lineRange: vscode.Range, label: string): vscode.DecorationOptions {
  return { range: lineRange, renderOptions: { after: { contentText: label } } };
}

export async function updateGitignoreDecorations(
  editor: vscode.TextEditor,
  decoration: vscode.TextEditorDecorationType
): Promise<void> {
  const document = editor.document;
  if (document.languageId !== 'ignore') { return; }

  const patternLines: { index: number; text: string; range: vscode.Range }[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    const text = line.text.trim();
    if (!text || text.startsWith('#')) { continue; }
    patternLines.push({ index: i, text, range: line.range });
  }

  // Build a stable decorations array; mutate labels in-place to avoid full redraws.
  const decorations = patternLines.map(l => makeDecoration(l.range, '⟵ counting…'));
  editor.setDecorations(decoration, decorations);

  await Promise.all(patternLines.map(async ({ index, text }, i) => {
    const count = await countPatternMatches(text);
    const label = count === 0 ? '⟵ ⚠ no matches' : `⟵ ${count === 1000 ? '1000+' : count} file${count === 1 ? '' : 's'}`;
    decorations[i] = makeDecoration(patternLines[i].range, label);
    editor.setDecorations(decoration, decorations);
  }));
}

export async function createGitignoreHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
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
