# Changelog

## 1.1.0 — 19 April 2026

### New Features
- Hover tooltips for .gitignore patterns showing plain-English explanations
- Inline decorations displaying match counts for each pattern
- Theme-aware colors for decorations (CodeLens style)
- Activate on .gitignore language mode

### Bug Fixes
- Resolve path issues in .gitignore handling
- Improve pattern parsing

### Refactoring
- Modularize gitignore handling with dedicated parser and decorator modules
- Add gitignoreParser.ts, patternDecorator.ts, and toggleManager.ts

### Documentation
- Expand README with .gitignored comparison and features

### Maintenance
- Add GitHub Actions workflow for automated release

## 1.0.0 — 8th April 2026
- Initial release
- Toggle .gitignore'd files via Explorer toolbar, status bar, or Command Palette
- Auto-updates when .gitignore changes on disk
- Per-workspace state persistence
