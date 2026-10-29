"use strict";

/**
 * ChatLeak core: finds AI coding tool transcripts, prompt histories and local-only agent settings
 * that leak through git or published packages. No dependency on the VS Code API, so the same code
 * runs in the editor and in the plain Node unit tests.
 *
 * The editor layer (extension.js) collects facts (which candidate files exist, which are tracked
 * by git, what the ignore files and package manifests say) and buildFindings() turns them into
 * findings. All parsers here are pure functions.
 *
 * Glob matching: patterns from .gitignore, .npmignore, .dockerignore, MANIFEST.in, package.json
 * "files" and the user's exclude setting are matched with a memoised matcher (shared safe-glob
 * snippet, O(pattern x path)), never converted to a RegExp, so no pattern can cause catastrophic
 * backtracking. Patterns are still normalised the same way: runs of three or more stars collapse to
 * a globstar, repeated globstar-slash segments collapse to one, and patterns longer than 300 characters or more than four
 * globstars are refused (they never match).
 *
 * Git: every call goes through runGit(): execFile with an argument array (no shell), a hardened
 * environment (GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM = null device, GIT_CONFIG_NOSYSTEM=1,
 * GIT_LITERAL_PATHSPECS=1, inherited GIT_DIR etc. removed), leading `-c core.fsmonitor=` and
 * `-c core.hooksPath=<null device>`, `--no-pager`, paths after `--`, capped output and a timeout.
 *
 * No network access of any kind.
 */

const { execFile } = require("child_process");
const path = require("path");
const data = require("./data");

const NULL_DEVICE = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
const MAX_PATTERN = 300;
const MAX_GLOBSTARS = 4;
const MAX_PATH = 4096;
const MAX_SECRETS_PER_FILE = 50;

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const RULES = {
  CL001: { title: "Transcript committed to git", severity: "error" },
  CL002: { title: "Not covered by .gitignore", severity: "warning" },
  CL003: { title: "Secret inside AI chat file", severity: "error" },
  CL004: { title: "Local-only settings committed", severity: "warning" },
  CL005: { title: "Ships in a package or image", severity: "warning" },
  CL006: { title: "Still in git history", severity: "information" },
};
const RULE_IDS = Object.keys(RULES);
const SEVERITIES = ["error", "warning", "information", "hint", "off"];

/** User overrides from the chatLeak.rules setting: { CL001: "warning", ... } (invalid values dropped). */
function sanitizeRuleOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id of RULE_IDS) {
    const v = raw[id];
    if (typeof v === "string" && SEVERITIES.includes(v)) out[id] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** A workspace-relative POSIX path that can not escape its root. */
function isSafeRelPath(rel) {
  if (typeof rel !== "string" || rel === "" || rel.length > MAX_PATH || rel.includes("\0")) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return false;
  return !rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "" || seg.toLowerCase() === ".git");
}

/** Show control characters in a path as escapes (display only). */
function displayPath(p) {
  return String(p).replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    const map = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };
    return map[ch] || "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
}

function dirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}
function baseOf(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
}
/** rel relative to dir ("" = root), or null when rel is not inside dir. */
function relTo(dir, rel) {
  if (!dir) return rel;
  return rel.startsWith(dir + "/") ? rel.slice(dir.length + 1) : null;
}
function joinRel(dir, rel) {
  return dir ? dir + "/" + rel : rel;
}

const SKIP_SEGMENTS = new Set(["node_modules", ".git"]);

/**
 * Which ENTRIES row a workspace-relative path belongs to.
 * Returns { entry, subject } (subject is the path to report: the file, or the directory for
 * aggregated entries) or null.
 */
function classifyPath(rel) {
  if (!isSafeRelPath(rel)) return null;
  const segs = rel.split("/");
  if (segs.some((s) => SKIP_SEGMENTS.has(s))) return null;
  const last = segs.length - 1;
  const name = segs[last];
  for (const entry of data.ENTRIES) {
    const m = entry.match;
    if (m.basename && name === m.basename) return { entry, subject: rel };
    if (m.ext && name.length > m.ext.length && name.endsWith(m.ext)) return { entry, subject: rel };
    if (m.pathSuffix && last >= m.pathSuffix.length - 1 && m.pathSuffix.every((s, k) => segs[last - (m.pathSuffix.length - 1) + k] === s)) return { entry, subject: rel };
    if (m.dirRe) {
      for (let i = 0; i < last; i++) if (m.dirRe.test(segs[i])) return { entry, subject: segs.slice(0, i + 1).join("/") };
    }
    if (m.dirPath) {
      const n = m.dirPath.length;
      for (let i = 0; i + n - 1 < last; i++) {
        if (m.dirPath.every((s, k) => segs[i + k] === s)) return { entry, subject: segs.slice(0, i + n).join("/") };
      }
    }
  }
  return null;
}

/** True when the entry has no content condition, or the text satisfies it. */
function contentMatches(entry, text) {
  if (!entry.content) return true;
  if (typeof text !== "string") return false;
  try {
    return !!entry.content(text);
  } catch (_) {
    return false;
  }
}

/** Glob patterns (for findFiles) that cover every entry. */
const CANDIDATE_GLOBS = [
  "**/.aider.chat.history.md",
  "**/.aider.input.history",
  "**/.aider.llm.history",
  "**/.aider.tags.cache.v*/**",
  "**/.aider.conf.yml",
  "**/.specstory/history/**",
  "**/.claude/settings.local.json",
  "**/CLAUDE.local.md",
  "**/.continue/.env",
  "**/*.chat",
];

/** Manifest / ignore files the package and .gitignore checks read. */
const CONFIG_GLOBS = [
  "**/.gitignore",
  "**/.npmignore",
  "**/.dockerignore",
  "**/*.dockerignore",
  "**/package.json",
  "**/pyproject.toml",
  "**/setup.py",
  "**/MANIFEST.in",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.Dockerfile",
  "**/Containerfile",
];

function isConfigFile(rel) {
  const n = baseOf(rel);
  return (
    n === ".gitignore" || n === ".npmignore" || n === ".dockerignore" || n.endsWith(".dockerignore") ||
    n === "package.json" || n === "pyproject.toml" || n === "setup.py" || n === "MANIFEST.in" ||
    isDockerfileName(n)
  );
}

function isDockerfileName(n) {
  return n === "Dockerfile" || n === "Containerfile" || (n.startsWith("Dockerfile.") && !n.endsWith(".dockerignore")) || (n.endsWith(".Dockerfile") && n.length > 11);
}

// ---------------------------------------------------------------------------------------------
// Glob matching (no RegExp)
// ---------------------------------------------------------------------------------------------

// Safe glob matcher (shared snippet): memoised walk, never a RegExp.
/**
 * Compile a glob into a matcher { source, test(path) }, or null when the pattern is refused.
 * No RegExp is built: matching is a memoised walk over (pattern token, path index), so its cost is
 * bounded by pattern length x path length whatever the pattern ("*a*a*a*b" cannot backtrack).
 * Repeated "**\/" and runs of "*" are collapsed first; patterns over 300 characters or with more
 * than 4 "**" are refused. Inside [...] a backslash escapes the next character, so "\\", "[" and "]"
 * are always literal there.
 */
function globToRegExp(glob) {
  const g = String(glob).replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
  if (g.length > 300 || (g.match(/\*\*/g) || []).length > 4) return null;
  const alts = expandBraces(g, 0);
  if (!alts) return null;
  const programs = [];
  for (const a of alts) {
    const p = globTokens(a);
    if (!p) return null;
    programs.push(p);
  }
  return {
    source: g,
    test(path) {
      const s = String(path);
      if (s.length > 4096) return false;
      return programs.some((p) => globMatch(p, s));
    },
  };
}

/** Expand {a,b} groups (nested allowed), at most 64 alternatives; null when that is exceeded. */
function expandBraces(g, depth) {
  if (depth > 8) return null;
  let open = -1;
  let level = 0;
  let close = -1;
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "\\") {
      i++;
      continue;
    }
    if (g[i] === "{") {
      if (level === 0) open = i;
      level++;
    } else if (g[i] === "}" && level > 0) {
      level--;
      if (level === 0) {
        close = i;
        break;
      }
    }
  }
  if (open < 0 || close < 0) return [g];
  const parts = [];
  let cur = "";
  level = 0;
  for (let i = open + 1; i < close; i++) {
    const c = g[i];
    if (c === "{") level++;
    if (c === "}") level--;
    if (c === "," && level === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    const sub = expandBraces(g.slice(0, open) + part + g.slice(close + 1), depth + 1);
    if (!sub) return null;
    out.push(...sub);
    if (out.length > 64) return null;
  }
  return out;
}

function globTokens(g) {
  const toks = [];
  for (let i = 0; i < g.length; ) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        toks.push({ t: "dirs" });
        i += 3;
      } else {
        toks.push({ t: "any" });
        i += 2;
      }
      continue;
    }
    if (c === "*") {
      toks.push({ t: "star" });
      i++;
      continue;
    }
    if (c === "?") {
      toks.push({ t: "one" });
      i++;
      continue;
    }
    if (c === "[") {
      const cls = parseClass(g, i);
      if (cls) {
        toks.push(cls.tok);
        i = cls.next;
        continue;
      }
    }
    if (c === "\\" && i + 1 < g.length) {
      toks.push({ t: "lit", c: g[i + 1] });
      i += 2;
      continue;
    }
    toks.push({ t: "lit", c });
    i++;
  }
  return toks;
}

/** [...] / [!...] / [^...] with ranges; a backslash escapes the next character. */
function parseClass(g, start) {
  let i = start + 1;
  let neg = false;
  if (g[i] === "!" || g[i] === "^") {
    neg = true;
    i++;
  }
  const items = [];
  let first = true;
  while (i < g.length) {
    let c = g[i];
    if (c === "]" && !first) return { tok: { t: "cls", neg, items }, next: i + 1 };
    first = false;
    if (c === "\\" && i + 1 < g.length) c = g[++i];
    let hi = c;
    if (g[i + 1] === "-" && i + 2 < g.length && g[i + 2] !== "]") {
      hi = g[i + 2] === "\\" && i + 3 < g.length ? g[i + 3] : g[i + 2];
      i += g[i + 2] === "\\" ? 4 : 3;
    } else i++;
    if (hi < c) return null;
    items.push([c, hi]);
  }
  return null;
}

function globMatch(toks, s) {
  const P = toks.length;
  const S = s.length;
  const memo = new Uint8Array((P + 1) * (S + 1));
  const m = (pi, si) => {
    const key = pi * (S + 1) + si;
    if (memo[key]) return memo[key] === 1;
    let r;
    if (pi === P) r = si === S;
    else {
      const t = toks[pi];
      const ch = s[si];
      if (t.t === "lit") r = si < S && ch === t.c && m(pi + 1, si + 1);
      else if (t.t === "one") r = si < S && ch !== "/" && m(pi + 1, si + 1);
      else if (t.t === "cls") r = si < S && ch !== "/" && t.items.some(([a, b]) => ch >= a && ch <= b) !== t.neg && m(pi + 1, si + 1);
      else if (t.t === "star") r = m(pi + 1, si) || (si < S && ch !== "/" && m(pi, si + 1));
      else if (t.t === "any") r = m(pi + 1, si) || (si < S && m(pi, si + 1));
      else {
        // "**/": zero or more whole directories.
        r = m(pi + 1, si);
        if (!r) {
          const j = s.indexOf("/", si);
          r = j >= 0 && m(pi, j + 1);
        }
      }
    }
    memo[key] = r ? 1 : 2;
    return r;
  };
  return m(0, 0);
}

/** Normalised source of a glob, or null when it is refused. */
function normalizeGlob(p) {
  if (typeof p !== "string") return null;
  const g = globToRegExp(p);
  return g ? g.source : null;
}

/**
 * Compile a glob to a matcher function (path => boolean). A refused pattern never matches.
 * braces: expand {a,b} (VS Code style excludes); ignore files and manifests treat braces literally.
 */
function compileGlob(pattern, braces) {
  if (typeof pattern !== "string") return () => false;
  const src = braces ? pattern : pattern.replace(/(?<!\\)[{}]/g, "\\$&");
  const g = globToRegExp(src);
  return g ? (s) => typeof s === "string" && g.test(s) : () => false;
}

/** Excluder for the chatLeak.exclude setting: workspace-relative VS Code style globs. */
function makeExcluder(globs) {
  const fns = [];
  for (const g of Array.isArray(globs) ? globs : []) fns.push(compileGlob(g, true));
  return (rel) => {
    if (typeof rel !== "string") return true;
    if (rel.split("/").some((s) => SKIP_SEGMENTS.has(s))) return true;
    return fns.some((f) => f(rel));
  };
}

// ---------------------------------------------------------------------------------------------
// Ignore files (.gitignore / .npmignore / .dockerignore)
// ---------------------------------------------------------------------------------------------

/**
 * Parse an ignore file. mode "git" (gitignore and npmignore) or "docker".
 * Returns [{ neg, dirOnly, match: (rel) => bool, raw }].
 */
function parseIgnore(text, mode) {
  const rules = [];
  if (typeof text !== "string") return rules;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let raw of lines) {
    if (mode === "git") {
      // trailing spaces are dropped unless escaped (a loop: /(?<!\\)[ \t]+$/ was quadratic)
      let end = raw.length;
      while (end > 0 && (raw[end - 1] === " " || raw[end - 1] === "\t")) end--;
      if (end < raw.length) raw = raw.slice(0, end > 0 && raw[end - 1] === "\\" ? end + 1 : end);
    } else {
      raw = raw.trim();
    }
    if (!raw || raw.startsWith("#")) continue;
    let line = raw;
    let neg = false;
    if (line.startsWith("!")) {
      neg = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (mode === "docker") {
      // path.posix.normalize is quadratic on long "../" chains: no real path is this long.
      if (line.length > MAX_PATH) continue;
      line = path.posix.normalize(line.replace(/^\/+/, "")).replace(/\/+$/, "");
      if (line === "." || line === "") continue;
    } else {
      if (line.endsWith("/")) {
        dirOnly = true;
        line = line.replace(/\/+$/, "");
      }
      if (!line) continue;
      const anchored = line.includes("/");
      line = line.replace(/^\/+/, "");
      if (!anchored) line = "**/" + line;
    }
    const m = compileGlob(line);
    rules.push({ neg, dirOnly, match: m, raw });
  }
  return rules;
}

/**
 * Gitignore-style matcher over several ignore files.
 * files: [{ dir, text }] where dir is the workspace-relative folder of the file ("" for root).
 * Returns (rel, isDir) => boolean, with git semantics: a path is ignored when it, or any parent
 * directory, is ignored (a file under an ignored directory can not be re-included).
 */
function makeGitIgnoreMatcher(files) {
  const parsed = (files || []).map((f) => ({ dir: f.dir || "", rules: parseIgnore(f.text, "git") }))
    .sort((a, b) => (a.dir ? a.dir.split("/").length : 0) - (b.dir ? b.dir.split("/").length : 0));
  const direct = (rel, isDir) => {
    let ignored = false;
    for (const f of parsed) {
      const sub = relTo(f.dir, rel);
      if (sub === null || sub === "") continue;
      for (const r of f.rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.match(sub)) ignored = !r.neg;
      }
    }
    return ignored;
  };
  return (rel, isDir) => {
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i++) {
      if (direct(segs.slice(0, i).join("/"), true)) return true;
    }
    return direct(rel, !!isDir);
  };
}

/**
 * .dockerignore matcher (paths relative to the build context). Docker semantics: every pattern
 * is anchored at the context root, a pattern that matches a parent directory matches everything
 * inside it, and the last matching line wins (so `!` can re-include).
 */
function makeDockerIgnoreMatcher(text) {
  const rules = parseIgnore(text, "docker");
  return (rel) => {
    const segs = rel.split("/");
    const prefixes = [];
    for (let i = 1; i <= segs.length; i++) prefixes.push(segs.slice(0, i).join("/"));
    let ignored = false;
    for (const r of rules) {
      if (prefixes.some((p) => r.match(p))) ignored = !r.neg;
    }
    return ignored;
  };
}

/** Escape a literal path for an ignore file line. */
function ignoreEscape(rel) {
  let s = String(rel).replace(/[\\*?[\]]/g, (c) => "\\" + c);
  if (/^[#!]/.test(s)) s = "\\" + s;
  if (/ $/.test(s)) s = s.replace(/ $/, "\\ ");
  return s;
}

// ---------------------------------------------------------------------------------------------
// npm package contents
// ---------------------------------------------------------------------------------------------

function safeJson(text) {
  try {
    const v = JSON.parse(String(text || "").replace(/^﻿/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

/**
 * Would `npm publish` of the package at pkgDir include relInPkg?
 * view: { texts: Map<rel, text> } (workspace-relative config files).
 * Returns { included, reason } or null when the package is not publishable.
 */
function npmIncludes(pkgDir, pkgText, relInPkg, view) {
  const pkg = safeJson(pkgText);
  if (!pkg || pkg.private === true || typeof pkg.name !== "string" || !pkg.name) return null;
  if (Array.isArray(pkg.files)) {
    let included = false;
    let via = null;
    for (const raw of pkg.files) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      let p = raw.trim();
      const neg = p.startsWith("!");
      if (neg) p = p.slice(1);
      p = p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
      if (p === "" || p === ".") p = "**";
      const m1 = compileGlob(p);
      const m2 = compileGlob(p + "/**");
      const segs = relInPkg.split("/");
      let hit = m1(relInPkg) || m2(relInPkg);
      for (let i = 1; !hit && i < segs.length; i++) hit = m1(segs.slice(0, i).join("/"));
      if (hit) {
        included = !neg;
        via = raw;
      }
    }
    if (!included) return { included: false };
    // A .npmignore in a sub-directory still applies inside "files"; the root one does not.
    if (npmSubdirIgnored(pkgDir, relInPkg, view, true)) return { included: false };
    return { included: true, reason: `"files" entry "${via}" includes it` };
  }
  if (npmSubdirIgnored(pkgDir, relInPkg, view, false)) return { included: false };
  const hasNpmignore = view.texts.has(joinRel(pkgDir, ".npmignore"));
  return { included: true, reason: hasNpmignore ? ".npmignore does not exclude it" : "there is no \"files\" field or .npmignore, and .gitignore does not exclude it" };
}

/** npm per-directory ignore: .npmignore if the folder has one, else .gitignore. */
function npmSubdirIgnored(pkgDir, relInPkg, view, skipRoot) {
  const files = [];
  const segs = relInPkg.split("/");
  for (let i = 0; i < segs.length; i++) {
    const sub = segs.slice(0, i).join("/");
    if (skipRoot && i === 0) continue;
    const dir = joinRel(pkgDir, sub);
    const npmi = joinRel(dir, ".npmignore");
    const giti = joinRel(dir, ".gitignore");
    if (view.texts.has(npmi)) files.push({ dir: sub, text: view.texts.get(npmi) });
    else if (view.texts.has(giti)) files.push({ dir: sub, text: view.texts.get(giti) });
  }
  return makeGitIgnoreMatcher(files)(relInPkg, false);
}

// ---------------------------------------------------------------------------------------------
// Python sdist contents
// ---------------------------------------------------------------------------------------------

// Horizontal whitespace only: "^\s*" under the m flag crossed blank lines and backtracked
// quadratically on a file of empty lines.
const HWS = "[^\\S\\r\\n\\u2028\\u2029]*";

/**
 * The body of the first `key = [ ... ]` array at the start of a line, or null. The closing "]"
 * is found with indexOf, so an unclosed array costs one pass, not one pass per later line.
 */
function tomlArrayBody(text, key) {
  const m = new RegExp("^" + HWS + key + "\\s*=\\s*\\[", "m").exec(text);
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = text.indexOf("]", open);
  return close < 0 ? null : text.slice(open, close);
}

/** Minimal pyproject.toml reader for what the sdist check needs. */
function parsePyproject(text) {
  const t = String(text || "");
  const backendM = new RegExp("^" + HWS + "build-backend\\s*=\\s*[\"']([^\"']+)[\"']", "m").exec(t);
  const requires = tomlArrayBody(t, "requires") || "";
  const out = {
    backend: backendM ? backendM[1] : "",
    scm: /setuptools[_-]scm/i.test(requires),
    hatch: { include: [], exclude: [], onlyInclude: [], ignoreVcs: false },
  };
  // [tool.hatch.build] and [tool.hatch.build.targets.sdist] sections
  const sectionRe = new RegExp("^" + HWS + "\\[([^\\]\\n]+)\\]\\s*$", "gm");
  const sections = [];
  let m;
  while ((m = sectionRe.exec(t))) sections.push({ name: m[1].trim(), hdr: m.index, start: m.index + m[0].length });
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.name !== "tool.hatch.build" && s.name !== "tool.hatch.build.targets.sdist") continue;
    const body = t.slice(s.start, i + 1 < sections.length ? sections[i + 1].hdr : t.length);
    for (const [key, field] of [["include", "include"], ["exclude", "exclude"], ["only-include", "onlyInclude"]]) {
      const arr = tomlArrayBody(body, key);
      if (arr !== null) {
        const vals = [];
        const strRe = /["']([^"'\n]*)["']/g;
        let sm;
        while ((sm = strRe.exec(arr))) vals.push(sm[1]);
        out.hatch[field].push(...vals);
      }
    }
    if (new RegExp("^" + HWS + "ignore-vcs\\s*=\\s*true\\b", "m").test(body)) out.hatch.ignoreVcs = true;
  }
  return out;
}

/** Parse MANIFEST.in into commands: [{ cmd, args }]. */
function parseManifestIn(text) {
  const cmds = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Continuation lines are collected and joined once (re-slicing a growing string was quadratic).
    let piece = lines[i].replace(/#.*$/, "").trim();
    const joined = [];
    while (piece.endsWith("\\") && i + 1 < lines.length) {
      joined.push(piece.slice(0, -1));
      piece = lines[++i].replace(/#.*$/, "").trim();
    }
    joined.push(piece);
    const line = joined.join(" ");
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (["include", "exclude", "recursive-include", "recursive-exclude", "global-include", "global-exclude", "graft", "prune"].includes(cmd)) {
      cmds.push({ cmd, args: parts.slice(1).map((a) => a.replace(/^\.\/+/, "").replace(/\/+$/, "")) });
    }
  }
  return cmds;
}

/** Apply MANIFEST.in commands to one project-relative file. base: included before the commands run. */
function manifestDecides(cmds, rel, base) {
  let included = !!base;
  const name = baseOf(rel);
  const under = (dir) => dir === "" || dir === "." || compileGlob(dir + "/**")(rel);
  for (const { cmd, args } of cmds) {
    switch (cmd) {
      case "include":
        if (args.some((p) => compileGlob(p)(rel))) included = true;
        break;
      case "exclude":
        if (args.some((p) => compileGlob(p)(rel))) included = false;
        break;
      case "recursive-include":
        if (args.length > 1 && under(args[0]) && args.slice(1).some((p) => compileGlob(p)(name))) included = true;
        break;
      case "recursive-exclude":
        if (args.length > 1 && under(args[0]) && args.slice(1).some((p) => compileGlob(p)(name))) included = false;
        break;
      case "global-include":
        if (args.some((p) => compileGlob(p)(name))) included = true;
        break;
      case "global-exclude":
        if (args.some((p) => compileGlob(p)(name))) included = false;
        break;
      case "graft":
        if (args.some((d) => under(d))) included = true;
        break;
      case "prune":
        if (args.some((d) => d !== "" && d !== "." && under(d))) included = false;
        break;
      default:
        break;
    }
  }
  return included;
}

/**
 * Would the sdist of the Python project at projDir include relInProj?
 * tracked: boolean | null (whether git tracks the file; null = unknown).
 * Returns { included, reason, fixFile? } or null when no supported build backend is configured.
 */
function pythonSdistIncludes(projDir, relInProj, view, tracked) {
  const pyText = view.texts.get(joinRel(projDir, "pyproject.toml"));
  const hasSetupPy = view.texts.has(joinRel(projDir, "setup.py"));
  const manifest = view.texts.get(joinRel(projDir, "MANIFEST.in"));
  const info = parsePyproject(pyText);
  if (/hatchling/.test(info.backend)) {
    const h = info.hatch;
    if (h.exclude.some((p) => gitStyleMatch(p, relInProj))) return { included: false };
    if (h.onlyInclude.length) {
      if (!h.onlyInclude.some((p) => gitStyleMatch(p, relInProj))) return { included: false };
    } else if (h.include.length) {
      if (!h.include.some((p) => gitStyleMatch(p, relInProj))) return { included: false };
    }
    if (!h.ignoreVcs && view.gitIgnored && view.gitIgnored(joinRel(projDir, relInProj))) return { included: false };
    return { included: true, reason: "hatchling puts every file that .gitignore does not exclude into the sdist", via: "pyproject.toml" };
  }
  const setuptools = /setuptools/.test(info.backend) || (!info.backend && (hasSetupPy || pyText !== undefined));
  if (!setuptools) return null;
  const base = info.scm && tracked === true;
  if (manifest === undefined && !base) return { included: false };
  const cmds = parseManifestIn(manifest);
  const included = manifestDecides(cmds, relInProj, base);
  if (!included) return { included: false };
  const why = manifest !== undefined && !base ? "MANIFEST.in includes it" : manifest !== undefined ? "setuptools-scm adds every tracked file and MANIFEST.in does not exclude it" : "setuptools-scm adds every tracked file to the sdist";
  return { included: true, reason: why, via: manifest !== undefined ? "MANIFEST.in" : "pyproject.toml" };
}

/** A gitignore-style pattern (hatch include/exclude) matched against a project-relative path. */
function gitStyleMatch(pattern, rel) {
  return makeGitIgnoreMatcher([{ dir: "", text: String(pattern) }])(rel, false);
}

// ---------------------------------------------------------------------------------------------
// Docker build context
// ---------------------------------------------------------------------------------------------

/** COPY / ADD sources of a Dockerfile (from the build context only; --from= copies are skipped). */
function parseDockerCopySources(text) {
  const out = [];
  const logical = [];
  let cur = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (!cur && line.startsWith("#")) continue;
    if (/\\\s*$/.test(line)) {
      cur += line.replace(/\\\s*$/, " ");
      continue;
    }
    cur += line;
    logical.push(cur);
    cur = "";
  }
  if (cur) logical.push(cur);
  for (const l of logical) {
    const m = /^(COPY|ADD)\s+([\s\S]*)$/i.exec(l.trim());
    if (!m) continue;
    let rest = m[2].trim();
    const flags = [];
    while (rest.startsWith("--")) {
      const sp = rest.search(/\s/);
      if (sp < 0) {
        rest = "";
        break;
      }
      flags.push(rest.slice(0, sp));
      rest = rest.slice(sp).trim();
    }
    if (flags.some((f) => /^--from=/i.test(f))) continue;
    let args;
    if (rest.startsWith("[")) {
      const arr = safeJsonArray(rest);
      if (!arr) continue;
      args = arr;
    } else {
      args = rest.split(/\s+/).filter(Boolean);
    }
    if (args.length < 2) continue;
    for (const src of args.slice(0, -1)) {
      if (/^(?:https?|git):\/\//i.test(src) || src.startsWith("<<")) continue;
      out.push(src);
    }
  }
  return out;
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch (_) {
    return null;
  }
}

/** Does any COPY/ADD source cover the context-relative path? */
function dockerCopies(sources, relInCtx) {
  const segs = relInCtx.split("/");
  for (let src of sources) {
    if (typeof src !== "string" || src.length > MAX_PATH) continue;
    src = path.posix.normalize(src.replace(/^\/+/, ""));
    if (src === "." || src === "./" || src === "*" || src === "") return true;
    if (src.startsWith("..")) continue;
    src = src.replace(/\/+$/, "");
    const m = compileGlob(src);
    for (let i = 1; i <= segs.length; i++) if (m(segs.slice(0, i).join("/"))) return true;
  }
  return false;
}

/**
 * Exposure of one workspace-relative file through a Dockerfile (context = the Dockerfile's folder).
 * Returns { included, reason, ignoreFile } or null when the file is outside that context.
 */
function dockerIncludes(dockerfileRel, relFile, view) {
  const ctx = dirOf(dockerfileRel);
  const inCtx = relTo(ctx, relFile);
  if (inCtx === null) return null;
  const text = view.texts.get(dockerfileRel);
  const sources = parseDockerCopySources(text);
  if (!dockerCopies(sources, inCtx)) return { included: false };
  const specific = dockerfileRel + ".dockerignore";
  const general = joinRel(ctx, ".dockerignore");
  const ignoreFile = view.texts.has(specific) ? specific : general;
  const ignText = view.texts.get(ignoreFile);
  if (ignText !== undefined && makeDockerIgnoreMatcher(ignText)(inCtx)) return { included: false };
  return {
    included: true,
    reason: ignText === undefined ? "COPY/ADD copies it and there is no .dockerignore" : `COPY/ADD copies it and ${baseOf(ignoreFile)} does not exclude it`,
    ignoreFile,
    ctx,
  };
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_RE = /(?:x{4,}|X{4,}|\*{3,}|\.{3}|your|example|placeholder|redacted|dummy|changeme|replace|insert|<|>|\$\{|\{\{)/i;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True for strings that look like documentation placeholders rather than real keys. */
function looksPlaceholder(body) {
  if (PLACEHOLDER_RE.test(body)) return true;
  if (/^(.)\1+$/.test(body)) return true;
  if (/^(?:0123456789|abcdef|ABCDEF|1234)/.test(body) && entropy(body) < 4) return true;
  if (body.length >= 16 && entropy(body) < 3) return true;
  if (/EXAMPLE/i.test(body)) return true;
  return false;
}

/** "sk-proj-**** (164 chars)": only the public prefix is shown, never any part of the secret. */
function maskSecret(prefix, length) {
  return `${prefix}**** (${length} chars)`;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function posAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

/**
 * Secret-like strings in text. opts.generic also flags `api_key: <long value>` assignments.
 * Returns [{ kind, label, line, character, endLine, endCharacter, masked, length }]; the secret
 * value itself is never part of the result.
 */
function findSecrets(text, opts) {
  if (typeof text !== "string" || !text) return [];
  const o = opts || {};
  const hits = [];
  for (const p of data.SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, "g");
    let m;
    while ((m = re.exec(text))) {
      const tok = m[0];
      const body = p.id === "private-key" ? "" : tok.slice(p.prefix.length);
      if (p.id !== "private-key" && looksPlaceholder(body)) continue;
      const shownPrefix = p.id === "github" || p.id === "slack" || p.id === "aws" ? tok.slice(0, 4) : p.prefix;
      hits.push({ kind: p.id, label: p.label, start: m.index, end: m.index + tok.length, masked: p.id === "private-key" ? "-----BEGIN ... PRIVATE KEY-----" : maskSecret(shownPrefix, tok.length), length: tok.length });
      if (hits.length > MAX_SECRETS_PER_FILE * 4) break;
    }
  }
  if (o.generic) {
    const re = new RegExp(data.GENERIC_ASSIGNMENT.source, "gim");
    let m;
    while ((m = re.exec(text))) {
      const key = m[1];
      const val = m[2];
      if (looksPlaceholder(val) || entropy(val) < 3.5 || /^[a-z_]+$/i.test(val) || /^\d+$/.test(val)) continue;
      const start = m.index + m[0].indexOf(val, m[0].indexOf(key) + key.length);
      hits.push({ kind: "generic", label: `"${key.slice(0, 40)}" value`, start, end: start + val.length, masked: maskSecret("", val.length), length: val.length });
      if (hits.length > MAX_SECRETS_PER_FILE * 4) break;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue;
    kept.push(h);
    lastEnd = h.end;
    if (kept.length >= MAX_SECRETS_PER_FILE) break;
  }
  const starts = lineStarts(text);
  return kept.map((h) => {
    const a = posAt(starts, h.start);
    const b = posAt(starts, h.end);
    return { kind: h.kind, label: h.label, line: a.line, character: a.character, endLine: b.line, endCharacter: b.character, masked: h.masked, length: h.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

function hardenedEnv() {
  // Drop every inherited GIT_* variable (GIT_EXEC_PATH, GIT_CONFIG_KEY_n, GIT_ATTR_SOURCE, ...),
  // not only a known list, then set our own.
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) base[k] = v;
  const env = Object.assign(base, {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  });
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EDITOR",
    "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT",
  ]) {
    delete env[k];
  }
  return env;
}

const LEADING_ARGS = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=" + NULL_DEVICE, "-c", "core.quotePath=true", "-c", "core.untrackedCache=false", "--no-pager"];

/**
 * Run git with execFile (no shell) and the hardened environment. Never throws; resolves to
 * { ok, code, stdout: Buffer, stderr, truncated }.
 * opts: { maxBytes, timeout, input, extraConfig: [["key", "value"], ...], env: { overrides } }
 */
function runGit(gitPath, cwd, args, opts) {
  const o = opts || {};
  const extra = [];
  for (const [k, v] of o.extraConfig || []) extra.push("-c", `${k}=${v}`);
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(gitPath || "git", LEADING_ARGS.concat(extra, args), {
        cwd,
        env: Object.assign(hardenedEnv(), o.env || {}),
        encoding: "buffer",
        maxBuffer: o.maxBytes || 8 * 1024 * 1024,
        timeout: o.timeout || 15000,
        windowsHide: true,
        shell: false,
      }, (err, stdout, stderr) => {
        const truncated = !!(err && (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err.killed));
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ ok: !err, code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""), stderr: String(stderr || "").slice(0, 4096), truncated });
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: String(e), truncated: false });
      return;
    }
    if (child.stdin) {
      child.stdin.on("error", () => {});
      if (o.input) child.stdin.end(o.input);
      else child.stdin.end();
    }
  });
}

/** Split NUL-separated git output into safe relative paths. */
function splitZ(buf) {
  return buf.toString("utf8").split("\0").map((s) => s.replace(/^\n+/, "")).filter((s) => s && isSafeRelPath(s));
}

/** `git rev-parse --show-prefix` in cwd: "" or "sub/dir/" when inside a work tree, null otherwise. */
async function gitPrefix(gitPath, cwd) {
  const r = await runGit(gitPath, cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], { maxBytes: 64 * 1024, timeout: 10000 });
  if (!r.ok) return null;
  const lines = r.stdout.toString("utf8").split("\n");
  if (lines[0].trim() !== "true") return null;
  return (lines[1] || "").trim();
}

/** Tracked files under cwd, relative to cwd. Returns { files, truncated } or null when git failed. */
async function gitLsFiles(gitPath, cwd) {
  const r = await runGit(gitPath, cwd, ["ls-files", "-z", "--cached"], { maxBytes: 64 * 1024 * 1024, timeout: 30000 });
  if (!r.ok && !r.truncated) return null;
  return { files: splitZ(r.stdout), truncated: r.truncated };
}

/** Which of the given cwd-relative paths git ignores (any source: .gitignore, info/exclude, global excludes). */
async function gitCheckIgnore(gitPath, cwd, rels, excludesFile) {
  if (!rels.length) return new Set();
  const extraConfig = excludesFile ? [["core.excludesFile", excludesFile]] : [];
  // check-ignore rejects literal pathspecs; it only reads, and the paths come from our own candidate list.
  const r = await runGit(gitPath, cwd, ["check-ignore", "-z", "--stdin"], { input: rels.map((r) => "./" + r).join("\0") + "\0", maxBytes: 4 * 1024 * 1024, timeout: 15000, extraConfig, env: { GIT_LITERAL_PATHSPECS: "0" } });
  // exit 1 = none ignored
  if (!r.ok && r.code !== 1) return null;
  // Every path is sent as "./<path>" so a name starting with ":" is never read as pathspec magic.
  return new Set(r.stdout.toString("utf8").split("\0").map((s) => s.replace(/^\n+/, "").replace(/^\.\//, "")).filter((s) => s && isSafeRelPath(s)));
}

/**
 * Paths added in any commit reachable from any ref, relative to cwd, with how many commits added
 * them: Map<rel, count>. Output is capped; { added, truncated } or null on failure.
 */
async function gitLogAdded(gitPath, cwd) {
  const r = await runGit(gitPath, cwd, ["log", "--all", "--diff-filter=A", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", "--format=", "-z"], { maxBytes: 64 * 1024 * 1024, timeout: 120000 });
  if (!r.ok && !r.truncated) return null;
  const added = new Map();
  for (const p of splitZ(r.stdout)) added.set(p, (added.get(p) || 0) + 1);
  return { added, truncated: r.truncated };
}

/** `git rm --cached` one path (recursively for a directory). Returns { ok, stderr }. */
async function gitRmCached(gitPath, cwd, rel, isDir) {
  if (!isSafeRelPath(rel)) return { ok: false, stderr: "unsafe path" };
  const args = ["rm", "--cached", "--quiet"];
  if (isDir) args.push("-r");
  args.push("--", rel);
  const r = await runGit(gitPath, cwd, args, { maxBytes: 1024 * 1024, timeout: 30000 });
  return { ok: r.ok, stderr: r.stderr };
}

/**
 * The user's own global excludes file (core.excludesFile) from ~/.gitconfig or
 * $XDG_CONFIG_HOME/git/config. Git itself reads it, but the hardened environment hides the
 * global config, so it is passed explicitly. readText(path) => string | null.
 */
function resolveGlobalExcludesFile(env, home, readText) {
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  for (const cfg of [path.join(home, ".gitconfig"), path.join(xdg, "git", "config")]) {
    const text = readText(cfg);
    if (typeof text !== "string") continue;
    let inCore = false;
    for (const line of text.split(/\r?\n/)) {
      const sec = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (sec) {
        inCore = sec[1].toLowerCase() === "core";
        continue;
      }
      const kv = /^\s*excludesfile\s*=\s*(.+?)\s*$/i.exec(line);
      if (inCore && kv) {
        let v = kv[1].replace(/^"(.*)"$/, "$1");
        if (v.startsWith("~/")) v = path.join(home, v.slice(2));
        if (path.isAbsolute(v)) return v;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

/**
 * The ignore line to add to the repository's root .gitignore (dir "") for a subject.
 * Uses the tool's documented pattern when it covers the path, otherwise the exact path.
 */
function gitignoreLineFor(entry, subject) {
  if (entry.ignorePattern) {
    const m = makeGitIgnoreMatcher([{ dir: "", text: entry.ignorePattern }]);
    if (m(subject, entry.aggregate === "dir")) return entry.ignorePattern;
  }
  return "/" + ignoreEscape(subject) + (entry.aggregate === "dir" ? "/" : "");
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + "s"}`;
}

/**
 * Build findings from collected facts.
 *
 * cands: [{
 *   subject, entry, isDir, members: [rel], onDisk, tracked (true|false|null), trackedCount,
 *   repoIgnored (bool), localIgnored (true|false|null),
 *   secrets: [{ file, line, character, endLine, endCharacter, label, masked }],
 *   exposures: [{ kind: "npm"|"python"|"docker", via, reason, fix?: { file, line } }]
 * }]
 * history: [{ path, entry, count }] (paths added in past commits that are no longer tracked)
 * overrides: sanitized chatLeak.rules
 */
function buildFindings(cands, history, overrides) {
  const ov = overrides || {};
  const out = [];
  const sev = (rule, entryDefault) => ov[rule] || entryDefault || RULES[rule].severity;
  let seq = 0;
  const push = (f) => {
    if (f.severity === "off") return;
    f.id = `${f.rule}:${f.rel}:${++seq}`;
    out.push(f);
  };
  for (const c of cands || []) {
    const e = c.entry;
    const name = displayPath(c.subject);
    const secretCount = (c.secrets || []).length;
    const secretNote = secretCount ? ` (contains ${plural(secretCount, "secret-like string")})` : "";
    const ignoreFix = { type: "ignore", file: ".gitignore", line: gitignoreLineFor(e, c.subject) };
    const untrackFix = { type: "untrack", path: c.subject, isDir: !!c.isDir };
    const fileCount = c.isDir && c.trackedCount ? ` (${plural(c.trackedCount, "file")})` : "";
    const diagFile = c.isDir ? null : c.subject;

    if (c.tracked === true) {
      const rule = e.kind === "local" ? "CL004" : "CL001";
      const fixes = [untrackFix];
      if (!c.repoIgnored) fixes.push(ignoreFix);
      const label = e.kind === "local"
        ? `${name} is committed${secretNote || ` (local-only ${e.what})`}`
        : `${name} is committed${c.isDir && c.trackedCount && secretCount ? ` (${plural(c.trackedCount, "file")}, ${plural(secretCount, "secret-like string")})` : fileCount + secretNote}`;
      let message;
      if (rule === "CL001") {
        message = `${name} is the ${e.tool} ${e.what} and it is committed to git${fileCount}. Everyone who can read the repository can read the conversation, the code and data pasted into it${secretCount ? ` and ${plural(secretCount, "secret-like string")}` : ""}.`;
        if (e.id === "specstory") message += " SpecStory suggests versioning this history; review it before pushing, or add .specstory to .gitignore.";
        message += ` Fix: stop tracking it (git rm --cached keeps your copy), add ${ignoreFix.line} to .gitignore${secretCount ? ", rotate the keys" : ""}, and if it was pushed, remove it from history.`;
      } else {
        message = `${name} holds ${e.tool} ${e.what} meant for one person, and it is committed to git${secretCount ? ` with ${plural(secretCount, "secret-like string")}` : ""}. Fix: stop tracking it (git rm --cached keeps your copy) and add ${ignoreFix.line} to .gitignore.`;
      }
      push({ rule, severity: sev(rule, e.tracked), rel: c.subject, subject: c.subject, file: diagFile, entryId: e.id, tool: e.tool, line: 0, character: 0, endLine: 0, endCharacter: 0, label, short: RULES[rule].title, message, fixes });
    } else if (c.onDisk && !c.repoIgnored && e.ignoreAdvised) {
      const localOnly = c.localIgnored === true;
      const label = localOnly ? `${name} is only ignored by your local git excludes` : `${name} is not in .gitignore`;
      const message = localOnly
        ? `${name} (${e.tool} ${e.what}) is ignored on this machine only (global excludes or .git/info/exclude), not by the repository's .gitignore. A teammate's copy can be committed. Add ${ignoreFix.line} to .gitignore.`
        : `${name} (${e.tool} ${e.what}) is not covered by the repository's .gitignore${c.tracked === null ? "" : " and is not committed yet"}, so the next "git add ." commits it. Add ${ignoreFix.line} to .gitignore.`;
      push({ rule: "CL002", severity: localOnly ? (ov.CL002 || "information") : sev("CL002"), rel: c.subject, subject: c.subject, file: diagFile, entryId: e.id, tool: e.tool, line: 0, character: 0, endLine: 0, endCharacter: 0, label, short: RULES.CL002.title, message, fixes: [ignoreFix] });
    }

    for (const s of c.secrets || []) {
      const fname = displayPath(s.file);
      push({
        rule: "CL003", severity: sev("CL003"), rel: s.file, subject: c.subject, file: s.file, entryId: e.id, tool: e.tool,
        line: s.line, character: s.character, endLine: s.endLine, endCharacter: s.endCharacter,
        label: `${s.label} ${s.masked} on line ${s.line + 1}`,
        short: RULES.CL003.title,
        message: `${fname} (${e.tool} ${e.what}) contains a ${s.label} (${s.masked}). Transcripts keep everything pasted into a chat. Rotate the key now, then delete it from the file${c.tracked ? " and from git history" : ""}.`,
        fixes: [],
      });
    }

    for (const x of c.exposures || []) {
      const where = x.kind === "npm" ? "ships in the npm package" : x.kind === "python" ? "ships in the Python sdist" : "is copied into the Docker image";
      push({
        rule: "CL005", severity: sev("CL005"), rel: c.subject, subject: c.subject, file: diagFile, entryId: e.id, tool: e.tool,
        line: 0, character: 0, endLine: 0, endCharacter: 0,
        label: `${name} ${where}`,
        short: `${RULES.CL005.title} (${displayPath(x.via)})`,
        message: `${name} (${e.tool} ${e.what}) ${where} built from ${displayPath(x.via)}: ${x.reason}.${x.fix ? ` Add ${x.fix.line} to ${displayPath(x.fix.file)}.` : ""}`,
        fixes: x.fix ? [{ type: "ignore", file: x.fix.file, line: x.fix.line }] : [],
        via: x.via,
      });
    }
  }
  for (const h of history || []) {
    const name = displayPath(h.path);
    push({
      rule: "CL006", severity: sev("CL006"), rel: h.path, subject: h.path, file: null, entryId: h.entry.id, tool: h.entry.tool,
      line: 0, character: 0, endLine: 0, endCharacter: 0, history: true,
      label: `${name} is in past commits (added in ${plural(h.count, "commit")})`,
      short: RULES.CL006.title,
      message: `${name} (${h.entry.tool} ${h.entry.what}) is no longer tracked, but ${plural(h.count, "commit")} in this repository added it, so anyone with a clone can still read it. Rotate every key that was in it. To remove it, rewrite history (for example git filter-repo --invert-paths --path ${name}) and force-push; ChatLeak never rewrites history itself.`,
      fixes: [],
    });
  }
  const order = { error: 0, warning: 1, information: 2, hint: 3 };
  // Per file: the file-level row (committed / not ignored / packaged) first, then secrets by line.
  const fileLevel = (f) => (f.rule === "CL003" ? 1 : 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel) || fileLevel(a) - fileLevel(b) || (fileLevel(a) ? a.line - b.line : order[a.severity] - order[b.severity]));
  return out;
}

/** History hits: paths added in past commits, matching the table, not tracked now. */
function historyCandidates(added, trackedSet) {
  const bySubject = new Map();
  for (const [p, count] of added) {
    const cls = classifyPath(p);
    if (!cls) continue;
    if (trackedSet && trackedSet.has(p)) continue;
    const key = cls.subject;
    const prev = bySubject.get(key);
    if (prev) prev.count = Math.max(prev.count, count);
    else bySubject.set(key, { path: key, entry: cls.entry, count });
  }
  // A subject still partly tracked (a directory) is covered by CL001.
  if (trackedSet) {
    for (const t of trackedSet) {
      const cls = classifyPath(t);
      if (cls) bySubject.delete(cls.subject);
    }
  }
  return [...bySubject.values()].sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = {
  RULES,
  RULE_IDS,
  ENTRIES: data.ENTRIES,
  CANDIDATE_GLOBS,
  CONFIG_GLOBS,
  sanitizeRuleOverrides,
  isSafeRelPath,
  displayPath,
  classifyPath,
  contentMatches,
  isConfigFile,
  isDockerfileName,
  normalizeGlob,
  compileGlob,
  expandBraces,
  makeExcluder,
  parseIgnore,
  makeGitIgnoreMatcher,
  makeDockerIgnoreMatcher,
  ignoreEscape,
  npmIncludes,
  parsePyproject,
  parseManifestIn,
  manifestDecides,
  pythonSdistIncludes,
  parseDockerCopySources,
  dockerCopies,
  dockerIncludes,
  findSecrets,
  looksPlaceholder,
  maskSecret,
  hardenedEnv,
  runGit,
  gitPrefix,
  gitLsFiles,
  gitCheckIgnore,
  gitLogAdded,
  gitRmCached,
  resolveGlobalExcludesFile,
  gitignoreLineFor,
  buildFindings,
  historyCandidates,
  dirOf,
  baseOf,
  relTo,
  joinRel,
  NULL_DEVICE,
};
