"use strict";

/**
 * ChatLeak path table: the files AI coding tools write INTO a project folder, as documented by
 * each tool (or, where the docs only give the flag, by the tool's own source code).
 *
 * Verified 2026-10-24. Every entry names its source. Tools whose chat history is stored outside
 * the project (so it can not leak through git) are listed in NOT_IN_REPO for the record.
 *
 * Fields:
 *   id            stable id
 *   tool          product name shown in messages
 *   what          short noun for the file ("chat transcript", ...)
 *   kind          "transcript" (conversation or prompt log) or "local" (local-only settings or secrets)
 *   match         how a workspace-relative path is recognised (see core.classifyPath)
 *   aggregate     "dir": report the matched directory once instead of every file inside it
 *   ignorePattern the .gitignore line the tool's docs recommend (or the tool adds itself)
 *   ignoreAdvised false when the vendor recommends committing the file (CL002 is then not raised)
 *   tracked       default severity of CL001 / CL004 for this entry
 *   secrets       search the file for secret-like strings (CL003)
 *   generic       also flag generic `api_key: <long value>` assignments (only for config files)
 *   content       optional content check: a file only counts when this returns true
 *   source        where the path and the advice come from
 */

const ENTRIES = [
  {
    id: "aider-chat",
    tool: "Aider",
    what: "chat transcript",
    kind: "transcript",
    match: { basename: ".aider.chat.history.md" },
    ignorePattern: ".aider*",
    ignoreAdvised: true,
    tracked: "error",
    secrets: true,
    source: "https://aider.chat/docs/config/options.html (--chat-history-file default .aider.chat.history.md; --gitignore adds .aider* to .gitignore, default True)",
  },
  {
    id: "aider-input",
    tool: "Aider",
    what: "prompt input history",
    kind: "transcript",
    match: { basename: ".aider.input.history" },
    ignorePattern: ".aider*",
    ignoreAdvised: true,
    tracked: "error",
    secrets: true,
    source: "https://aider.chat/docs/config/options.html (--input-history-file default .aider.input.history)",
  },
  {
    id: "aider-llm",
    tool: "Aider",
    what: "raw LLM conversation log",
    kind: "transcript",
    match: { basename: ".aider.llm.history" },
    ignorePattern: ".aider*",
    ignoreAdvised: true,
    tracked: "error",
    secrets: true,
    source: "https://aider.chat/docs/config/options.html (--llm-history-file, documented example name .aider.llm.history)",
  },
  {
    id: "aider-tags",
    tool: "Aider",
    what: "repo map tags cache",
    kind: "transcript",
    match: { dirRe: /^\.aider\.tags\.cache\.v\d+$/ },
    aggregate: "dir",
    ignorePattern: ".aider*",
    ignoreAdvised: true,
    tracked: "warning",
    secrets: false,
    source: "https://github.com/Aider-AI/aider/blob/main/aider/repomap.py (TAGS_CACHE_DIR = .aider.tags.cache.v{CACHE_VERSION}, version 3 or 4)",
  },
  {
    id: "aider-conf",
    tool: "Aider",
    what: "config file with API keys",
    kind: "local",
    match: { basename: ".aider.conf.yml" },
    ignorePattern: ".aider*",
    ignoreAdvised: true,
    tracked: "warning",
    secrets: true,
    generic: true,
    // Only a .aider.conf.yml that actually sets a key counts (a team config without keys is fine to commit).
    content: (text) => /^[ \t]*(?:openai-api-key|anthropic-api-key|api-key)[ \t]*:[ \t]*(?!#)\S/m.test(text),
    source: "https://aider.chat/docs/config/aider_conf.html (openai-api-key, anthropic-api-key and api-key can be set in .aider.conf.yml)",
  },
  {
    id: "specstory",
    tool: "SpecStory",
    what: "saved AI chat history",
    kind: "transcript",
    match: { dirPath: [".specstory", "history"] },
    aggregate: "dir",
    ignorePattern: ".specstory",
    ignoreAdvised: false,
    tracked: "information",
    secrets: true,
    source: "https://docs.specstory.com/specstory/introduction (history saved to .specstory/history/); .specstory/.what-is-this.md written by SpecStory (recommends versioning, or adding .specstory to .gitignore)",
  },
  {
    id: "claude-settings-local",
    tool: "Claude Code",
    what: "personal project settings",
    kind: "local",
    match: { pathSuffix: [".claude", "settings.local.json"] },
    ignorePattern: "**/.claude/settings.local.json",
    ignoreAdvised: true,
    tracked: "warning",
    secrets: true,
    generic: true,
    source: "https://code.claude.com/docs/en/settings (.claude/settings.local.json: personal, kept out of git; if created by hand add it to .gitignore)",
  },
  {
    id: "claude-local-md",
    tool: "Claude Code",
    what: "personal instructions",
    kind: "local",
    match: { basename: "CLAUDE.local.md" },
    ignorePattern: "CLAUDE.local.md",
    ignoreAdvised: true,
    tracked: "warning",
    secrets: true,
    source: "https://code.claude.com/docs/en/memory (CLAUDE.local.md: private per-project preferences, add it to .gitignore)",
  },
  {
    id: "continue-env",
    tool: "Continue",
    what: "workspace secrets file",
    kind: "local",
    match: { pathSuffix: [".continue", ".env"] },
    ignorePattern: "**/.continue/.env",
    ignoreAdvised: true,
    tracked: "warning",
    secrets: true,
    generic: true,
    source: "https://docs.continue.dev/faqs (secrets read from <workspace-root>/.continue/.env; never commit .env files)",
  },
  {
    id: "jupyter-chat",
    tool: "Jupyter AI",
    what: "chat file",
    kind: "transcript",
    match: { ext: ".chat" },
    ignorePattern: null, // no documented pattern: the exact path is added
    ignoreAdvised: true,
    tracked: "warning",
    secrets: true,
    // jupyterlab-chat documents are JSON with a "messages" array; any other *.chat file is ignored.
    content: (text) => /^\s*\{/.test(text) && /"messages"\s*:\s*\[/.test(text) && /"(?:users|metadata)"\s*:/.test(text),
    source: "https://jupyter-ai.readthedocs.io/en/v3/getting-started.html (chats are files in the workspace); https://github.com/jupyterlab/jupyter-chat/blob/main/packages/jupyterlab-chat/src/token.ts (extensions: ['.chat'])",
  },
];

/**
 * Checked and not included: per their docs these tools keep chat history outside the project folder,
 * or document no local-only file in it. Cursor, Windsurf and GitHub Copilot Chat are not covered: no
 * chat transcript path inside the project could be verified from their docs (their project folders
 * hold rules meant to be shared).
 */
const NOT_IN_REPO = [
  { tool: "Cline", where: "VS Code globalStorage saoudrizwan.claude-dev/tasks/<id>/", source: "https://docs.cline.bot/troubleshooting/task-history-recovery" },
  { tool: "Codex", where: "AGENTS.override.md is documented as an instruction file, not a local-only one", source: "https://learn.chatgpt.com/docs/agent-configuration/agents-md" },
];

/**
 * Secret-like strings. Each pattern matches the whole token; `prefix` is the public, documented
 * prefix that is safe to show. Nothing after the prefix is ever displayed.
 */
const B = "(?<![A-Za-z0-9_\\-])";
const E = "(?![A-Za-z0-9_\\-])";
const SECRET_PATTERNS = [
  { id: "anthropic", label: "Anthropic API key", re: new RegExp(B + "sk-ant-[A-Za-z0-9]{2,8}\\d{0,3}-[A-Za-z0-9_\\-]{40,}" + E, "g"), prefix: "sk-ant-" },
  { id: "openrouter", label: "OpenRouter API key", re: new RegExp(B + "sk-or-v1-[a-f0-9]{64}" + E, "g"), prefix: "sk-or-v1-" },
  { id: "openai-project", label: "OpenAI project key", re: new RegExp(B + "sk-proj-[A-Za-z0-9_\\-]{40,}" + E, "g"), prefix: "sk-proj-" },
  { id: "openai-svc", label: "OpenAI service account key", re: new RegExp(B + "sk-svcacct-[A-Za-z0-9_\\-]{40,}" + E, "g"), prefix: "sk-svcacct-" },
  { id: "openai-admin", label: "OpenAI admin key", re: new RegExp(B + "sk-admin-[A-Za-z0-9_\\-]{40,}" + E, "g"), prefix: "sk-admin-" },
  { id: "openai-style", label: "OpenAI-style API key", re: new RegExp(B + "sk-[A-Za-z0-9]{32,}" + E, "g"), prefix: "sk-" },
  { id: "google", label: "Google API key", re: new RegExp(B + "AIza[0-9A-Za-z_\\-]{35}" + E, "g"), prefix: "AIza" },
  { id: "groq", label: "Groq API key", re: new RegExp(B + "gsk_[A-Za-z0-9]{48,}" + E, "g"), prefix: "gsk_" },
  { id: "huggingface", label: "Hugging Face token", re: new RegExp(B + "hf_[A-Za-z0-9]{34,}" + E, "g"), prefix: "hf_" },
  { id: "xai", label: "xAI API key", re: new RegExp(B + "xai-[A-Za-z0-9]{70,}" + E, "g"), prefix: "xai-" },
  { id: "replicate", label: "Replicate API token", re: new RegExp(B + "r8_[A-Za-z0-9]{37}" + E, "g"), prefix: "r8_" },
  { id: "perplexity", label: "Perplexity API key", re: new RegExp(B + "pplx-[A-Za-z0-9]{48}" + E, "g"), prefix: "pplx-" },
  { id: "aws", label: "AWS access key ID", re: new RegExp(B + "(?:AKIA|ASIA)[A-Z0-9]{16}" + E, "g"), prefix: "AKIA" },
  { id: "github", label: "GitHub token", re: new RegExp(B + "gh[pousr]_[A-Za-z0-9]{36,}" + E, "g"), prefix: "gh" },
  { id: "github-pat", label: "GitHub fine-grained token", re: new RegExp(B + "github_pat_[A-Za-z0-9_]{60,}" + E, "g"), prefix: "github_pat_" },
  { id: "gitlab", label: "GitLab token", re: new RegExp(B + "glpat-[A-Za-z0-9_\\-]{20,}" + E, "g"), prefix: "glpat-" },
  { id: "slack", label: "Slack token", re: new RegExp(B + "xox[baprs]-[A-Za-z0-9\\-]{10,}" + E, "g"), prefix: "xox" },
  { id: "stripe", label: "Stripe live key", re: new RegExp(B + "(?:sk|rk)_live_[A-Za-z0-9]{24,}" + E, "g"), prefix: "sk_live_" },
  { id: "npm", label: "npm token", re: new RegExp(B + "npm_[A-Za-z0-9]{36}" + E, "g"), prefix: "npm_" },
  { id: "private-key", label: "private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, prefix: "-----BEGIN" },
];

/** `api_key: value` style assignments (only searched in local config files, never in transcripts). */
const GENERIC_ASSIGNMENT = /(?:^|[\s{,"'])((?:[A-Za-z0-9_]*?(?:api[_-]?key|secret|token|password|passwd)))["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-+/=.]{20,200})["']?/gim;

module.exports = { ENTRIES, NOT_IN_REPO, SECRET_PATTERNS, GENERIC_ASSIGNMENT, VERIFIED: "2026-10-24" };
