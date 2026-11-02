"use strict";

// ChatLeak: finds AI coding tool transcripts, prompt histories and local-only agent settings that
// leak through git or published packages. UI layer only: parsing and rules live in core.js.

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("./core");

const SOURCE = "ChatLeak";
const VIEW_ID = "chatLeak.view";
const CONTAINER_ID = "chatleak";
const MANDATORY_EXCLUDES = ["**/node_modules/**", "**/.git/**"];
const MAX_CONFIG_FILES = 3000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_MEMBERS_CHECKED = 50;
const POLL_MS = 10000;
const IGNORE_FILE_NAMES = /^(?:\.gitignore|\.npmignore|\.dockerignore|[^/]+\.dockerignore|MANIFEST\.in)$/;

let diagnostics;
let treeView;
let treeProvider;
let statusBar;
/** Current findings, each with folder info: { ...finding, folder, folderKey, key, uri } */
let findings = [];
/** folder uri string -> Map<rel, count> from the last on-demand history scan */
const historyAdded = new Map();
let historyScanned = false;
let scanSeq = 0;
let scanTimer;
let pollTimer;
let pollCount = 0;
let polling = false;
let lastSignature = "";
let lastScanStats = { candidates: 0, gitFolders: 0 };
/** Test hook: replaces the modal confirmation of "Stop Tracking" (set only by the in-editor tests). */
let confirmOverride = null;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** A setting value; in an untrusted workspace only the user's own (global) value is used. */
function setting(c, key, fallback) {
  if (vscode.workspace.isTrusted) {
    const v = c.get(key);
    return v === undefined ? fallback : v;
  }
  const info = c.inspect(key) || {};
  return info.globalValue !== undefined ? info.globalValue : info.defaultValue !== undefined ? info.defaultValue : fallback;
}

function readSettings() {
  const c = vscode.workspace.getConfiguration("chatLeak");
  let maxFiles = Number(setting(c, "maxFiles", 5000));
  if (!Number.isFinite(maxFiles) || maxFiles < 1) maxFiles = 5000;
  let maxKB = Number(setting(c, "maxFileSizeKB", 4096));
  if (!Number.isFinite(maxKB) || maxKB < 1) maxKB = 4096;
  const rawExclude = setting(c, "exclude", []);
  const userExclude = Array.isArray(rawExclude) ? rawExclude.filter((g) => typeof g === "string" && g.length <= 300).slice(0, 200) : [];
  const excludes = [...new Set([...MANDATORY_EXCLUDES, ...userExclude])];
  return {
    enabled: setting(c, "enabled", true) !== false,
    overrides: core.sanitizeRuleOverrides(setting(c, "rules", {})),
    maxFiles: Math.min(Math.floor(maxFiles), 100000),
    maxBytes: Math.min(Math.floor(maxKB), 65536) * 1024,
    excludes,
    isExcluded: core.makeExcluder(excludes),
  };
}

/** findFiles exclude glob from brace-free patterns (the rest is post-filtered). */
function findFilesExclude(s) {
  const simple = s.excludes.filter((g) => !/[{}]/.test(g));
  return simple.length ? `{${simple.join(",")}}` : null;
}

// ---------------------------------------------------------------------------------------------
// Confinement and reading
// ---------------------------------------------------------------------------------------------

function isInside(parent, child) {
  const r = path.relative(parent, child);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

async function realpathOrNull(p) {
  try {
    return await fs.promises.realpath(p);
  } catch (_) {
    return null;
  }
}

function fileFolders() {
  return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === "file");
}

/** Folder-relative POSIX path of a file uri inside folder, or null. */
function relInFolder(folder, uri) {
  const r = path.relative(folder.uri.fsPath, uri.fsPath);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  const rel = r.split(path.sep).join("/");
  return core.isSafeRelPath(rel) ? rel : null;
}

/** Absolute path of rel in folder when its real path stays inside the folder's real path. */
async function confined(folder, rel, mustExist) {
  if (!core.isSafeRelPath(rel)) return null;
  const abs = path.join(folder.uri.fsPath, ...rel.split("/"));
  if (!isInside(folder.uri.fsPath, abs)) return null;
  const root = await realpathOrNull(folder.uri.fsPath);
  if (!root) return null;
  const real = await realpathOrNull(abs);
  if (real) return isInside(root, real) ? abs : null;
  if (mustExist) return null;
  const parent = await realpathOrNull(path.dirname(abs));
  return parent && isInside(root, parent) ? abs : null;
}

/** Read at most max bytes of a regular file. Returns { text, size, truncated } or null. */
async function readHead(abs, max) {
  let fh;
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return null;
    fh = await fs.promises.open(abs, "r");
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return { text, size: st.size, truncated: st.size > max, mtime: st.mtimeMs };
  } catch (_) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function gitPath() {
  try {
    const g = vscode.extensions.getExtension("vscode.git");
    const api = g && g.isActive && g.exports && g.exports.getAPI ? g.exports.getAPI(1) : null;
    if (api && api.git && typeof api.git.path === "string" && api.git.path) return api.git.path;
  } catch (_) {
    /* fall back to PATH */
  }
  return "git";
}

let globalExcludesCache;
function globalExcludesFile() {
  if (globalExcludesCache === undefined) {
    globalExcludesCache = core.resolveGlobalExcludesFile(process.env, os.homedir(), (p) => {
      try {
        const st = fs.statSync(p);
        return st.isFile() && st.size < 1024 * 1024 ? fs.readFileSync(p, "utf8") : null;
      } catch (_) {
        return null;
      }
    });
  }
  return globalExcludesCache;
}

// ---------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------

/** Scan one workspace folder. Returns { findings, signature, candidates, git }. */
async function scanFolder(folder, s, seq, budget) {
  const trusted = vscode.workspace.isTrusted;
  const exclude = findFilesExclude(s);
  const candUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `{${core.CANDIDATE_GLOBS.join(",")}}`), exclude, s.maxFiles);
  const cfgUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `{${core.CONFIG_GLOBS.join(",")}}`), exclude, MAX_CONFIG_FILES);
  if (seq !== scanSeq) return null;
  const sig = [];

  // Config files (ignore files and manifests).
  const texts = new Map();
  for (const uri of cfgUris) {
    const rel = relInFolder(folder, uri);
    if (!rel || s.isExcluded(rel) || !core.isConfigFile(rel)) continue;
    const abs = await confined(folder, rel, true);
    if (!abs) continue;
    const r = await readHead(abs, MAX_CONFIG_BYTES);
    if (!r || r.truncated) continue;
    texts.set(rel, r.text);
    sig.push(rel + ":" + r.mtime);
  }
  const gitignores = [...texts.keys()].filter((r) => core.baseOf(r) === ".gitignore").map((r) => ({ dir: core.dirOf(r), text: texts.get(r) }));
  const repoIgnored = core.makeGitIgnoreMatcher(gitignores);
  const view = { texts, gitIgnored: (rel) => repoIgnored(rel, false) };

  // Git facts (trusted workspaces only).
  let tracked = null;
  let gitOk = false;
  const git = gitPath();
  if (trusted) {
    const prefix = await core.gitPrefix(git, folder.uri.fsPath);
    if (prefix !== null) {
      const ls = await core.gitLsFiles(git, folder.uri.fsPath);
      if (ls) {
        tracked = new Set(ls.files.filter((f) => !s.isExcluded(f)));
        gitOk = true;
        try {
          const st = await fs.promises.stat(path.join(folder.uri.fsPath, ".git", "index"));
          sig.push("index:" + st.mtimeMs);
        } catch (_) {
          /* worktree or sub-folder of a repo */
        }
      }
    }
  }
  if (seq !== scanSeq) return null;

  // Candidates by subject.
  const cands = new Map();
  const getCand = (cls) => {
    let c = cands.get(cls.subject);
    if (!c) {
      c = { subject: cls.subject, entry: cls.entry, isDir: cls.entry.aggregate === "dir", members: [], onDisk: false, tracked: gitOk ? false : null, trackedCount: 0, repoIgnored: false, localIgnored: null, secrets: [], exposures: [] };
      cands.set(cls.subject, c);
    }
    return c;
  };
  for (const uri of candUris) {
    const rel = relInFolder(folder, uri);
    if (!rel || s.isExcluded(rel)) continue;
    const cls = core.classifyPath(rel);
    if (!cls) continue;
    const abs = await confined(folder, rel, true);
    if (!abs) continue;
    const e = cls.entry;
    let head = null;
    if (e.content || e.secrets) {
      const cap = e.secrets && budget.bytes > 0 ? Math.min(s.maxBytes, budget.bytes) : HEAD_BYTES;
      head = await readHead(abs, Math.max(cap, e.content ? HEAD_BYTES : 0));
      if (!head) continue;
      budget.bytes -= head.text.length;
      sig.push(rel + ":" + head.mtime);
    }
    if (e.content && !core.contentMatches(e, head.text)) continue;
    const c = getCand(cls);
    c.onDisk = true;
    c.members.push(rel);
    if (e.secrets && head && !head.truncated) {
      for (const sec of core.findSecrets(head.text, { generic: !!e.generic })) c.secrets.push(Object.assign({ file: rel }, sec));
    }
  }
  if (tracked) {
    for (const t of tracked) {
      const cls = core.classifyPath(t);
      if (!cls) continue;
      // Content-gated entries only count when the file on disk passed the check.
      if (cls.entry.content && !cands.has(cls.subject)) continue;
      const c = getCand(cls);
      c.tracked = true;
      c.trackedCount++;
      if (!c.members.includes(t)) c.members.push(t);
    }
  }
  if (seq !== scanSeq) return null;

  // Ignore state.
  const untracked = [];
  for (const c of cands.values()) {
    c.repoIgnored = repoIgnored(c.subject, c.isDir);
    if (c.onDisk && c.tracked === false && !c.repoIgnored) untracked.push(c);
  }
  if (gitOk && untracked.length) {
    const ign = await core.gitCheckIgnore(git, folder.uri.fsPath, untracked.map((c) => c.subject), globalExcludesFile());
    if (ign) for (const c of untracked) c.localIgnored = ign.has(c.subject);
  }

  // Package exposure.
  const pkgFiles = [...texts.keys()].filter((r) => core.baseOf(r) === "package.json");
  const pyDirs = [...new Set([...texts.keys()].filter((r) => ["pyproject.toml", "setup.py"].includes(core.baseOf(r))).map((r) => core.dirOf(r)))];
  const dockerfiles = [...texts.keys()].filter((r) => core.isDockerfileName(core.baseOf(r)));
  const nearest = (dirs, rel) => dirs.filter((d) => core.relTo(d, rel) !== null).sort((a, b) => b.length - a.length)[0];
  for (const c of cands.values()) {
    if (!c.onDisk && !c.tracked) continue;
    const probes = c.isDir ? c.members.slice(0, MAX_MEMBERS_CHECKED) : [c.subject];
    // npm
    const pkg = nearest(pkgFiles.map((p) => core.dirOf(p)), c.subject);
    if (pkg !== undefined) {
      const pkgRel = core.joinRel(pkg, "package.json");
      for (const p of probes) {
        const r = core.npmIncludes(pkg, texts.get(pkgRel), core.relTo(pkg, p), view);
        if (r && r.included) {
          const pj = safeParse(texts.get(pkgRel));
          const hasFiles = pj && Array.isArray(pj.files);
          const ignFile = texts.has(core.joinRel(pkg, ".npmignore")) ? core.joinRel(pkg, ".npmignore") : core.joinRel(pkg, ".gitignore");
          const fix = hasFiles ? null : { file: ignFile, line: core.gitignoreLineFor(c.entry, core.relTo(pkg, c.subject)) };
          c.exposures.push({ kind: "npm", via: pkgRel, reason: r.reason, fix });
          break;
        }
      }
    }
    // Python sdist
    const py = nearest(pyDirs, c.subject);
    if (py !== undefined) {
      for (const p of probes) {
        const memberTracked = tracked ? tracked.has(p) : null;
        const r = core.pythonSdistIncludes(py, core.relTo(py, p), view, memberTracked);
        if (r && r.included) {
          const subjInProj = core.relTo(py, c.subject);
          let fix = null;
          if (r.via === "MANIFEST.in" || r.via === "pyproject.toml") {
            if (/hatchling/.test(core.parsePyproject(texts.get(core.joinRel(py, "pyproject.toml"))).backend)) fix = { file: core.joinRel(py, ".gitignore"), line: core.gitignoreLineFor(c.entry, subjInProj) };
            else if (!/\s/.test(subjInProj)) fix = { file: core.joinRel(py, "MANIFEST.in"), line: (c.isDir ? "prune " : "exclude ") + subjInProj };
          }
          c.exposures.push({ kind: "python", via: core.joinRel(py, r.via || "pyproject.toml"), reason: r.reason, fix });
          break;
        }
      }
    }
    // Docker
    for (const df of dockerfiles) {
      let hit = null;
      for (const p of probes) {
        const r = core.dockerIncludes(df, p, view);
        if (r && r.included) {
          hit = r;
          break;
        }
      }
      if (hit) {
        const inCtx = core.relTo(hit.ctx, c.subject);
        c.exposures.push({ kind: "docker", via: df, reason: hit.reason, fix: { file: hit.ignoreFile, line: core.ignoreEscape(inCtx) } });
      }
    }
  }

  // History hits from the last on-demand scan, re-filtered against what is tracked now.
  const added = historyAdded.get(folder.uri.toString());
  const history = added && tracked ? core.historyCandidates(added, tracked) : [];

  const list = core.buildFindings([...cands.values()], history, s.overrides);
  return { findings: list, signature: sig.sort().join("|"), candidates: cands.size, git: gitOk };
}

function safeParse(t) {
  try {
    return JSON.parse(t);
  } catch (_) {
    return null;
  }
}

async function fullScan() {
  const seq = ++scanSeq;
  const s = readSettings();
  vscode.commands.executeCommand("setContext", "chatLeak.enabled", s.enabled);
  if (!s.enabled) {
    findings = [];
    diagnostics.clear();
    stopPolling();
    refreshUi();
    return;
  }
  const folders = fileFolders();
  const multi = folders.length > 1;
  const next = [];
  const sigs = [];
  const budget = { bytes: MAX_SCAN_BYTES };
  let candidates = 0;
  let gitFolders = 0;
  for (const folder of folders) {
    const r = await scanFolder(folder, s, seq, budget);
    if (seq !== scanSeq) return;
    if (!r) continue;
    candidates += r.candidates;
    if (r.git) gitFolders++;
    sigs.push(folder.uri.toString() + "#" + r.signature);
    for (const f of r.findings) {
      const shown = multi ? `${folder.name}/${f.rel}` : f.rel;
      next.push(Object.assign({}, f, {
        folder,
        folderKey: folder.uri.toString(),
        key: `${folder.uri.toString()}::${f.rel}`,
        shownRel: shown,
        uri: f.file ? vscode.Uri.joinPath(folder.uri, ...f.file.split("/")) : null,
        uid: `${folder.uri.toString()}::${f.id}`,
      }));
    }
  }
  findings = next;
  lastSignature = sigs.join("\n");
  lastScanStats = { candidates, gitFolders };
  publishDiagnostics();
  refreshUi();
  if (vscode.window.state.focused) startPolling();
}

function scheduleScan(ms) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => fullScan().catch(() => {}), ms);
}

function toSeverity(sev) {
  const S = vscode.DiagnosticSeverity;
  return sev === "error" ? S.Error : sev === "information" ? S.Information : sev === "hint" ? S.Hint : S.Warning;
}

function publishDiagnostics() {
  diagnostics.clear();
  const byUri = new Map();
  for (const f of findings) {
    if (!f.uri) continue;
    const k = f.uri.toString();
    if (!byUri.has(k)) byUri.set(k, { uri: f.uri, list: [] });
    const range = f.rule === "CL003" ? new vscode.Range(f.line, f.character, f.endLine, f.endCharacter) : new vscode.Range(0, 0, 0, 1000);
    const d = new vscode.Diagnostic(range, f.message, toSeverity(f.severity));
    d.source = SOURCE;
    d.code = f.rule;
    byUri.get(k).list.push(d);
    d.chatLeakId = f.uid;
  }
  for (const { uri, list } of byUri.values()) diagnostics.set(uri, list);
}

// ---------------------------------------------------------------------------------------------
// Polling fallback: file watchers do not fire on every file system. While the window is focused
// a cheap signature (mtimes of the files from the last scan and of .git/index) is compared, and
// a full scan runs every minute to pick up new files.
// ---------------------------------------------------------------------------------------------

async function currentSignature() {
  const s = readSettings();
  const parts = [];
  for (const line of lastSignature.split("\n")) {
    if (!line) continue;
    const hash = line.indexOf("#");
    const folderKey = line.slice(0, hash);
    const folder = fileFolders().find((f) => f.uri.toString() === folderKey);
    if (!folder) return "changed";
    const items = [];
    for (const item of line.slice(hash + 1).split("|")) {
      if (!item) continue;
      const i = item.lastIndexOf(":");
      const rel = item.slice(0, i);
      let abs;
      if (rel === "index") abs = path.join(folder.uri.fsPath, ".git", "index");
      else if (!s.isExcluded(rel)) abs = path.join(folder.uri.fsPath, ...rel.split("/"));
      if (!abs) continue;
      try {
        const st = await fs.promises.stat(abs);
        items.push(rel + ":" + st.mtimeMs);
      } catch (_) {
        items.push(rel + ":gone");
      }
    }
    parts.push(folderKey + "#" + items.sort().join("|"));
  }
  return parts.join("\n");
}

async function pollOnce() {
  if (polling || !readSettings().enabled) return;
  polling = true;
  try {
    pollCount++;
    if (pollCount % 6 === 0) {
      await fullScan();
      return;
    }
    const sig = await currentSignature();
    if (sig !== lastSignature) await fullScan();
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (pollTimer || !readSettings().enabled) return;
  pollTimer = setInterval(() => {
    if (!vscode.window.state.focused) {
      stopPolling();
      return;
    }
    pollOnce().catch(() => {});
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Tree view, badge, status bar
// ---------------------------------------------------------------------------------------------

function refreshUi() {
  const s = readSettings();
  vscode.commands.executeCommand("setContext", "chatLeak.enabled", s.enabled);
  const all = s.enabled ? findings : [];
  const n = all.length;
  const errors = all.filter((f) => f.severity === "error").length;
  if (treeProvider) treeProvider.refresh();
  if (treeView) {
    treeView.badge = n ? { value: n, tooltip: `${n} AI chat leak finding${n === 1 ? "" : "s"}` } : undefined;
    treeView.message = !vscode.workspace.isTrusted && n ? "Untrusted workspace: committed files and git history are not checked." : undefined;
  }
  if (statusBar) {
    if (!s.enabled) statusBar.hide();
    else {
      statusBar.text = `$(comment-discussion) ChatLeak: ${n}`;
      statusBar.tooltip = n ? `${n} AI chat leak finding${n === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}). Click to open AI chat leaks.` : "No AI chat history or agent session leaks found. Click to open AI chat leaks.";
      statusBar.show();
    }
  }
}

const ICONS = { error: ["error", "list.errorForeground"], warning: ["warning", "list.warningForeground"], information: ["info", "notificationsInfoIcon.foreground"], hint: ["lightbulb", "notificationsInfoIcon.foreground"] };

function groups() {
  const map = new Map();
  for (const f of findings) {
    if (!map.has(f.key)) map.set(f.key, { key: f.key, shownRel: f.shownRel, rel: f.rel, folder: f.folder, list: [], history: !!f.history, isDir: !f.file && !f.history, uri: f.uri });
    const g = map.get(f.key);
    g.list.push(f);
    if (!g.uri && f.uri) g.uri = f.uri;
    if (f.file) g.isDir = false;
    if (!f.history) g.history = false;
  }
  return [...map.values()].sort((a, b) => a.shownRel.localeCompare(b.shownRel));
}

class LeakTreeProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() {
    this._emitter.fire();
  }
  dispose() {
    this._emitter.dispose();
  }
  getChildren(node) {
    if (!readSettings().enabled) return [];
    if (!node) return groups().map((g) => ({ type: "group", key: g.key }));
    if (node.type === "group") return findings.filter((f) => f.key === node.key).map((f) => ({ type: "finding", uid: f.uid }));
    return [];
  }
  getTreeItem(node) {
    const C = vscode.TreeItemCollapsibleState;
    if (node.type === "group") {
      const g = groups().find((x) => x.key === node.key);
      if (!g) return new vscode.TreeItem("(stale)", C.None);
      const item = new vscode.TreeItem(core.displayPath(core.baseOf(g.shownRel)), C.Expanded);
      const dir = core.dirOf(g.shownRel);
      item.description = `${dir ? core.displayPath(dir) + "  " : ""}${g.history ? "past commits  " : ""}${g.list.length}`;
      if (g.uri && !g.history) item.resourceUri = g.uri;
      item.iconPath = g.history ? new vscode.ThemeIcon("history") : g.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
      item.tooltip = `${core.displayPath(g.shownRel)}\n${g.list.length} finding${g.list.length === 1 ? "" : "s"}`;
      item.contextValue = "group";
      item.id = "group:" + g.key;
      return item;
    }
    const f = findings.find((x) => x.uid === node.uid);
    if (!f) return new vscode.TreeItem("(stale)", C.None);
    const item = new vscode.TreeItem(f.label, C.None);
    item.description = `${f.rule}  ${f.short}`;
    const [icon, color] = ICONS[f.severity] || ICONS.warning;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const fixText = f.fixes.map((x) => (x.type === "ignore" ? `Add "${x.line}" to ${x.file}` : "Stop tracking in git (git rm --cached, asks first)")).join("\n");
    item.tooltip = `${f.rule} ${core.RULES[f.rule].title}\n${core.displayPath(f.shownRel)}${f.rule === "CL003" ? ":" + (f.line + 1) : ""}\n\n${f.message}${fixText ? "\n\nActions:\n" + fixText : ""}`;
    let ctx = "finding";
    if (f.fixes.some((x) => x.type === "ignore")) ctx += ".ignorable";
    if (f.fixes.some((x) => x.type === "untrack")) ctx += ".untrackable";
    if (f.history) ctx += ".history";
    item.contextValue = ctx;
    item.id = "finding:" + f.uid;
    item.command = f.history
      ? { command: "chatLeak.showHistoryHelp", title: "How to remove from history", arguments: [f.uid] }
      : { command: "chatLeak.openFinding", title: "Go to finding", arguments: [f.uid] };
    return item;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** A live finding from a command argument (a uid string or a tree node); anything else is null. */
function findingFromArg(arg) {
  let uid = null;
  if (typeof arg === "string") uid = arg;
  else if (arg && typeof arg === "object" && arg.type === "finding" && typeof arg.uid === "string") uid = arg.uid;
  if (!uid) return null;
  return findings.find((f) => f.uid === uid) || null;
}

async function openFindingCmd(arg) {
  const f = findingFromArg(arg);
  if (!f || f.history) {
    vscode.window.showWarningMessage("ChatLeak: refusing to open something that is not a current finding inside the workspace.");
    return false;
  }
  const target = f.file || f.subject;
  const abs = await confined(f.folder, target, true);
  if (!abs) {
    vscode.window.showWarningMessage("ChatLeak: refusing to open something that is not a current finding inside the workspace.");
    return false;
  }
  const uri = vscode.Uri.file(abs);
  if (!f.file) {
    await vscode.commands.executeCommand("revealInExplorer", uri);
    return true;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc, { preview: true });
  const line = Math.min(f.line, Math.max(doc.lineCount - 1, 0));
  const pos = new vscode.Position(line, f.rule === "CL003" ? f.character : 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  return true;
}

/** Append fix.line to fix.file (an ignore file or MANIFEST.in inside the folder). */
async function addToIgnoreCmd(arg) {
  const f = findingFromArg(arg);
  const fix = f && f.fixes.find((x) => x.type === "ignore");
  if (!f || !fix) {
    vscode.window.showWarningMessage("ChatLeak: that finding is no longer current.");
    return false;
  }
  if (!core.isSafeRelPath(fix.file) || !IGNORE_FILE_NAMES.test(core.baseOf(fix.file)) || /[\r\n]/.test(fix.line)) {
    vscode.window.showWarningMessage("ChatLeak: refusing to edit that file.");
    return false;
  }
  const abs = await confined(f.folder, fix.file, false);
  if (!abs) {
    vscode.window.showWarningMessage("ChatLeak: refusing to edit a file outside the workspace.");
    return false;
  }
  const uri = vscode.Uri.file(abs);
  let exists = false;
  try {
    const st = await fs.promises.lstat(abs);
    if (!st.isFile() && !st.isSymbolicLink()) {
      vscode.window.showWarningMessage(`ChatLeak: ${fix.file} is not a file.`);
      return false;
    }
    exists = true;
  } catch (_) {
    exists = false;
  }
  const edit = new vscode.WorkspaceEdit();
  if (exists) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    if (text.split(/\r?\n/).some((l) => l.trim() === fix.line)) {
      vscode.window.showInformationMessage(`ChatLeak: ${fix.file} already has "${fix.line}".`);
      await fullScan();
      return true;
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const prefix = text.length && !/\r?\n$/.test(text) ? eol : "";
    edit.insert(uri, doc.positionAt(text.length), `${prefix}${fix.line}${eol}`);
  } else {
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), `${fix.line}\n`);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return false;
  const doc = await vscode.workspace.openTextDocument(uri);
  await doc.save();
  await fullScan();
  vscode.window.setStatusBarMessage(`ChatLeak: added "${fix.line}" to ${fix.file}`, 5000);
  return true;
}

async function confirmUntrack(rel, isDir) {
  if (confirmOverride) return confirmOverride(rel, isDir);
  const choice = await vscode.window.showWarningMessage(
    `Stop tracking ${core.displayPath(rel)}${isDir ? " (whole folder)" : ""} in git?`,
    { modal: true, detail: "ChatLeak runs \"git rm --cached\": the file stays on disk and is removed from the index. Commit the change to stop sharing it. Past commits still contain it: rotate any keys it held." },
    "Stop Tracking"
  );
  return choice === "Stop Tracking";
}

/** git rm --cached, only for a live finding, only in a trusted workspace, only after confirmation. */
async function untrackCmd(arg) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("ChatLeak: git commands are disabled in an untrusted workspace.");
    return false;
  }
  const f = findingFromArg(arg);
  const fix = f && f.fixes.find((x) => x.type === "untrack");
  if (!f || !fix || !core.isSafeRelPath(fix.path)) {
    vscode.window.showWarningMessage("ChatLeak: that finding is no longer current.");
    return false;
  }
  const abs = await confined(f.folder, fix.path, false);
  if (!abs) {
    vscode.window.showWarningMessage("ChatLeak: refusing to touch a path outside the workspace.");
    return false;
  }
  if (!(await confirmUntrack(fix.path, fix.isDir))) return false;
  const r = await core.gitRmCached(gitPath(), f.folder.uri.fsPath, fix.path, fix.isDir);
  if (!r.ok) {
    vscode.window.showErrorMessage(`ChatLeak: git rm --cached failed: ${r.stderr.split("\n")[0]}`);
    return false;
  }
  await fullScan();
  vscode.window.setStatusBarMessage(`ChatLeak: ${core.displayPath(fix.path)} is no longer tracked (commit to finish)`, 6000);
  return true;
}

async function scanHistoryCmd() {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage("ChatLeak: git history can only be scanned in a trusted workspace.");
    return { scanned: 0, hits: 0 };
  }
  const git = gitPath();
  let scanned = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "ChatLeak: scanning git history" }, async () => {
    for (const folder of fileFolders()) {
      if ((await core.gitPrefix(git, folder.uri.fsPath)) === null) continue;
      const r = await core.gitLogAdded(git, folder.uri.fsPath);
      if (!r) continue;
      historyAdded.set(folder.uri.toString(), r.added);
      scanned++;
    }
  });
  historyScanned = true;
  await fullScan();
  const hits = findings.filter((f) => f.history).length;
  if (!scanned) vscode.window.showInformationMessage("ChatLeak: no git repository found in the workspace.");
  else if (hits) vscode.window.showWarningMessage(`ChatLeak: ${hits} AI chat file${hits === 1 ? "" : "s"} found in past commits. See the AI chat leaks view.`);
  else vscode.window.showInformationMessage("ChatLeak: no AI chat transcripts or local agent settings found in git history.");
  return { scanned, hits };
}

function showHistoryHelpCmd(arg) {
  const f = findingFromArg(arg);
  if (!f || !f.history) {
    vscode.window.showWarningMessage("ChatLeak: that finding is no longer current.");
    return false;
  }
  const cmd = `git filter-repo --invert-paths --path ${shellQuote(f.subject)}`;
  vscode.window.showInformationMessage(
    `${core.displayPath(f.subject)} is in past commits. 1) Rotate every key it held. 2) Rewrite history, for example: ${cmd} 3) Force-push and ask collaborators to re-clone. ChatLeak never rewrites history itself.`,
    "Copy Command"
  ).then((choice) => {
    if (choice === "Copy Command") vscode.env.clipboard.writeText(cmd);
  }, () => {});
  return true;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------------------------
// Quick Fixes
// ---------------------------------------------------------------------------------------------

class FixProvider {
  provideCodeActions(doc, _range, context) {
    const out = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) continue;
      const f = findings.find((x) => x.uri && x.uri.toString() === doc.uri.toString() && x.rule === diag.code && x.message === diag.message);
      if (!f) continue;
      for (const fix of f.fixes) {
        if (fix.type === "ignore") {
          const a = new vscode.CodeAction(`Add "${fix.line}" to ${fix.file} (${f.rule})`, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [diag];
          a.isPreferred = true;
          a.command = { command: "chatLeak.addToIgnore", title: a.title, arguments: [f.uid] };
          out.push(a);
        } else if (fix.type === "untrack" && vscode.workspace.isTrusted) {
          const a = new vscode.CodeAction(`Stop tracking ${core.baseOf(fix.path)} in git, keep the file (${f.rule})`, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [diag];
          a.command = { command: "chatLeak.untrack", title: a.title, arguments: [f.uid] };
          out.push(a);
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

function relevant(uri) {
  if (!uri || uri.scheme !== "file") return false;
  const rel = uri.fsPath.split(path.sep).join("/");
  const name = core.baseOf(rel);
  return !!core.classifyPath(rel.replace(/^\/+/, "").split("/").slice(-6).join("/")) || core.isConfigFile(name) || name === "index";
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("chatleak");
  treeProvider = new LeakTreeProvider();
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: treeProvider, showCollapseAll: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  statusBar.command = "chatLeak.focusView";
  statusBar.name = "ChatLeak";

  const watcher = vscode.workspace.createFileSystemWatcher(`{${core.CANDIDATE_GLOBS.concat(core.CONFIG_GLOBS).join(",")}}`);
  const indexWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
  const onFs = () => scheduleScan(400);

  context.subscriptions.push(
    diagnostics,
    treeProvider,
    treeView,
    statusBar,
    watcher,
    indexWatcher,
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand("chatLeak.rescan", () => fullScan()),
    vscode.commands.registerCommand("chatLeak.scanHistory", () => scanHistoryCmd()),
    vscode.commands.registerCommand("chatLeak.openFinding", (arg) => openFindingCmd(arg)),
    vscode.commands.registerCommand("chatLeak.addToIgnore", (arg) => addToIgnoreCmd(arg)),
    vscode.commands.registerCommand("chatLeak.untrack", (arg) => untrackCmd(arg)),
    vscode.commands.registerCommand("chatLeak.showHistoryHelp", (arg) => showHistoryHelpCmd(arg)),
    vscode.commands.registerCommand("chatLeak.focusView", () => vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`)),
    vscode.commands.registerCommand("chatLeak.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "chatLeak")),
    watcher.onDidCreate(onFs),
    watcher.onDidChange(onFs),
    watcher.onDidDelete(onFs),
    indexWatcher.onDidChange(onFs),
    indexWatcher.onDidCreate(onFs),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (relevant(d.uri)) scheduleScan(200);
    }),
    vscode.window.onDidChangeWindowState((st) => {
      if (st.focused) {
        startPolling();
        pollOnce().catch(() => {});
      } else stopPolling();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("chatLeak")) scheduleScan(50);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleScan(200)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => scheduleScan(200)),
    { dispose: () => { clearTimeout(scanTimer); stopPolling(); } }
  );

  refreshUi();
  const ready = fullScan().catch(() => {});

  // Small API used by the in-editor tests.
  return {
    ready: () => ready,
    rescan: () => fullScan(),
    poll: () => pollOnce(),
    getFindings: () => findings.map((f) => Object.assign({}, f)),
    getTreeItems: async (node) => {
      const out = [];
      for (const child of treeProvider.getChildren(node)) out.push(Object.assign({ node: child }, treeProvider.getTreeItem(child)));
      return out;
    },
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    getStatusText: () => (statusBar ? statusBar.text : ""),
    getStats: () => Object.assign({ historyScanned }, lastScanStats),
    __setConfirm: (fn) => {
      confirmOverride = typeof fn === "function" ? fn : null;
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
