import * as fs from 'fs';
import * as path from 'path';

export interface ParsedPattern {
  raw: string;
  isNegation: boolean;
  anchored: boolean;
  directoryOnly: boolean;
  body: string;
  isGlob: boolean;
  hasSlash: boolean;
}

export function parsePattern(line: string): ParsedPattern | null {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) { return null; }
  const isNegation = raw.startsWith('!');
  const original = isNegation ? raw.slice(1) : raw;
  const anchored = original.startsWith('/');
  const directoryOnly = original.endsWith('/');
  const body = original.replace(/^\//, '').replace(/\/$/, '');
  return { raw, isNegation, anchored, directoryOnly, body, isGlob: /[*?[]/.test(body), hasSlash: body.includes('/') };
}

export function parseGitignore(root: string): string[] {
  const resolvedRoot = path.resolve(root);
  // amazonq-ignore-next-line
  const gitignorePath = path.resolve(resolvedRoot, '.gitignore');
  if (!gitignorePath.startsWith(resolvedRoot + path.sep)) { return []; }
  if (!fs.existsSync(gitignorePath)) { return []; }

  // amazonq-ignore-next-line
  return fs.readFileSync(gitignorePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => {
      l = l.replace(/\/$/, '');
      if (l.startsWith('/')) { return l.slice(1); }
      if (!l.includes('/')) { return `**/${l}`; }
      return l;
    });
}
