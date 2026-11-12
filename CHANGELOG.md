# Changelog

## 0.1.0 - Initial release

- Six rules for AI coding tool transcripts and local-only agent files: CL001 transcript committed to
  git, CL002 not covered by `.gitignore`, CL003 secret-like string inside (masked), CL004 local-only
  settings committed, CL005 shipped in an npm package, Python sdist or Docker build context, CL006
  still in git history (on-demand scan).
- Files from Aider, SpecStory, Claude Code, Continue and Jupyter AI, each verified against the
  tool's documentation or source (2026-10-24).
- AI chat leaks view in its own activity bar container, grouped by file, rows that name the file and
  the problem, inline actions (add to the ignore file, stop tracking with confirmation, history
  help) and a findings badge. Status bar `ChatLeak: N`.
- Quick Fixes on the files: add the documented pattern to `.gitignore`, `.npmignore`,
  `.dockerignore` or `MANIFEST.in`; `git rm --cached` after confirmation.
- Hardened git (no shell, hooks and fsmonitor off, global config ignored), trusted workspaces only.
  Untrusted workspaces still get the `.gitignore`, secret and package checks.
- No network, no telemetry.
