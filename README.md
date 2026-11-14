# ChatLeak: AI Chat History and Agent Session Leak Checker

AI coding tools write their conversations into your project folder. Aider keeps
`.aider.chat.history.md` and `.aider.input.history` next to your code, SpecStory saves every chat to
`.specstory/history/`, Jupyter AI stores chats as `.chat` files, and Claude Code and Continue keep
personal settings and secrets in `.claude/settings.local.json`, `CLAUDE.local.md` and
`.continue/.env`. One `git add .` later, the whole conversation is in the repository:

```text
#### why does the deploy fail?
Set the key like this:
    export OPENAI_API_KEY=sk-proj-...        <- pasted into the chat, now in git
#### here is the customer record that breaks it: ...
```

Transcripts keep everything: API keys pasted while debugging, internal code, customer data, and the
prompts themselves. They also ship by accident in npm packages, Python sdists and Docker images.

ChatLeak finds these files, tells you exactly how each one leaks (committed, missing from
`.gitignore`, holding a key, or packaged), and fixes the safe part for you.

## What you see

- **Activity bar**: a ChatLeak icon opens the **AI chat leaks** view. Findings are grouped by file,
  and every row names the file and the problem:
  `.aider.chat.history.md is committed (contains 2 secret-like strings)`,
  `OpenAI project key sk-proj-**** (164 chars) on line 7`,
  `pkg/.aider.input.history ships in the npm package`. A badge shows the number of findings.
- **Inline actions** on a row: add the documented pattern to `.gitignore` (or `.dockerignore`,
  `.npmignore`, `MANIFEST.in`), stop tracking the file in git (asks first), and, for files found
  in past commits, how to remove them from history.
- **Problems and Quick Fixes** on the files themselves, with the exact key range underlined.
- **Status bar**: `ChatLeak: N`. Click it to open the view.
- **Scan Git History** (view title button): finds transcripts that were committed and later
  deleted, so they are still in every clone.

Secrets are never shown: only the public prefix and the length (`ghp_**** (40 chars)`).

## Rules

| ID | Rule | Default | Example | Action |
| --- | --- | --- | --- | --- |
| CL001 | Transcript committed to git | Error (Jupyter AI chats: Warning; SpecStory history: Information) | `.aider.chat.history.md is committed (contains 2 secret-like strings)` | Stop tracking (`git rm --cached`, after confirmation), add to `.gitignore` |
| CL002 | Transcript or local-only file not covered by `.gitignore` | Warning (Information when only your local git excludes cover it) | `CLAUDE.local.md is not in .gitignore` | Add the documented pattern to `.gitignore` |
| CL003 | Secret-like string inside an AI chat file | Error | `Anthropic API key sk-ant-**** (108 chars) on line 12` | Rotate the key, then delete it |
| CL004 | Local-only settings committed | Warning | `.claude/settings.local.json is committed (local-only personal project settings)` | Stop tracking, add to `.gitignore` |
| CL005 | Ships in a package or image | Warning | `.aider.chat.history.md ships in the npm package`, `... ships in the Python sdist`, `... is copied into the Docker image` | Add to `.npmignore`, `.dockerignore`, `MANIFEST.in` or `.gitignore` |
| CL006 | Still in git history (on demand) | Information | `old/.aider.llm.history is in past commits (added in 1 commit)` | Instructions: rotate keys, rewrite history with `git filter-repo`. ChatLeak never rewrites history. |

### Files checked

| Tool | Files | Recommended ignore line |
| --- | --- | --- |
| Aider | `.aider.chat.history.md`, `.aider.input.history`, `.aider.llm.history`, `.aider.tags.cache.v*/`, `.aider.conf.yml` when it sets `openai-api-key`, `anthropic-api-key` or `api-key` | `.aider*` (what Aider itself adds) |
| SpecStory | `.specstory/history/` | `.specstory` |
| Claude Code | `.claude/settings.local.json`, `CLAUDE.local.md` | `**/.claude/settings.local.json`, `CLAUDE.local.md` |
| Continue | `.continue/.env` | `**/.continue/.env` |
| Jupyter AI | `*.chat` files that are Jupyter chat documents | the exact path |

Every path comes from the tool's own documentation or source code (checked 2026-10-24). Tools that
keep chat history outside the project folder, such as Cline, can not leak it through git and are
not checked.

SpecStory recommends versioning `.specstory/history`, so a committed SpecStory history is only
Information and a missing `.gitignore` entry is not reported. Keys inside it are still errors.

Claude Code adds `**/.claude/settings.local.json` to your global git excludes when it creates the
file. That protects your machine only, so ChatLeak reports it as Information and suggests the
repository `.gitignore` line for your teammates.

### Secret patterns

OpenAI (project, service account, admin and classic keys), Anthropic, Google, Groq, Hugging Face,
xAI, OpenRouter, Replicate, Perplexity, AWS access key IDs, GitHub, GitLab, Slack, Stripe live keys,
npm tokens and private key blocks. Local settings files are also checked for long random
`api_key` / `token` / `secret` / `password` values. Placeholders such as `sk-proj-xxxx`,
`<your key>` and `AKIAIOSFODNN7EXAMPLE` are ignored.

### Packages

- **npm**: the nearest `package.json` that is not `private`, with its `files` field, `.npmignore`,
  or `.gitignore` when there is no `.npmignore`.
- **Python sdist**: `MANIFEST.in` (`include`, `exclude`, `recursive-include`, `global-include`,
  `graft`, `prune` ...), setuptools-scm (every tracked file), and hatchling (every file that
  `.gitignore` does not exclude, plus `include` / `exclude` / `only-include`).
- **Docker**: each `Dockerfile` whose `COPY` or `ADD` copies the file from the folder it is in,
  minus `.dockerignore` or a Dockerfile-specific `<name>.dockerignore`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `chatLeak.enabled` | `true` | Turn the checks on or off. |
| `chatLeak.rules` | `{}` | Severity per rule (`error`, `warning`, `information`, `hint`, `off`), e.g. `{ "CL002": "information" }`. |
| `chatLeak.maxFiles` | `5000` | Maximum number of candidate files read. |
| `chatLeak.maxFileSizeKB` | `4096` | Largest file searched for secrets. |
| `chatLeak.exclude` | `node_modules`, `.git`, `.venv`, `venv`, `site-packages` | Globs that are never scanned. |

## Commands

- `ChatLeak: Rescan Workspace`
- `ChatLeak: Scan Git History for Past Transcripts`
- `ChatLeak: Show AI Chat Leaks`
- `ChatLeak: Open Settings`

## Privacy and safety

No network, no telemetry. Files are read only inside the workspace (symlinks that lead outside are
skipped) and only up to the size limit. Git runs only in trusted workspaces, through `execFile`
with no shell, with repository hooks and fsmonitor disabled and your global git config ignored (except your global excludes file), and only for
`ls-files`, `check-ignore`, `log` (on demand) and `rm --cached` (after you confirm). ChatLeak never
commits, pushes or rewrites history.

In an untrusted workspace ChatLeak runs no git commands, so committed files and git history are not
checked, and the repository's own ChatLeak settings are ignored (only your user settings apply).

## Limitations

- The `.gitignore` check reads the repository's `.gitignore` files; `.git/info/exclude` and global
  excludes are only used (in trusted workspaces) to tell "ignored on your machine only" apart.
- The Docker build context is assumed to be the folder of the Dockerfile; a different context set in
  compose files or CI is not followed.
- Poetry, Flit and PDM sdists are not checked. Nested `.npmignore` rules inside the `files` field
  are approximated.
- Secret detection is pattern based. A key without a known prefix in a transcript is not found.
- Git history is scanned only on demand, and only for files that were added under a path ChatLeak
  knows.

## Learn more

- [Aider options: chat history files and --gitignore](https://aider.chat/docs/config/options.html)
- [Claude Code settings: settings.local.json](https://code.claude.com/docs/en/settings)
- [SpecStory introduction](https://docs.specstory.com/specstory/introduction)

## License

MIT - included with the extension.
