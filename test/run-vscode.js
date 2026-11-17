"use strict";

// Launches a real, isolated VS Code window with ChatLeak loaded from this folder and runs
// test/vscode/index.js inside it, once trusted and once in an untrusted workspace. During the
// trusted run it takes a screenshot of the (hidden) display when the test asks for one.
// Usage: node test/run-vscode.js [tmpBaseDir]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const fx = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "cl-vscode-"));
const outsideDir = path.join(base, "outside");
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(outsideDir, "CLAUDE.local.md"), "outside secret " + fx.KEYS.github + "\n");
const fakeHome = path.join(base, "home");
fs.mkdirSync(path.join(fakeHome, ".config", "git"), { recursive: true });
// The user's own global excludes (as Claude Code writes them).
fs.writeFileSync(path.join(fakeHome, ".config", "git", "ignore"), "**/.claude/settings.local.json\n");
const marker = path.join(base, "PWNED");

const TITLE = "chatleak-shot-" + process.pid;

function write(root, rel, text) {
  const p = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function git(root, ...args) {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.fsmonitor=", ...args], {
    cwd: root,
    env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: fakeHome }),
    stdio: "pipe",
  });
}

/** A fresh fixture repository (each run edits files, so each run gets its own copy). */
function makeWorkspace(name) {
  const root = path.join(base, name);
  fs.mkdirSync(root);
  git(root, "init", "-q");
  write(root, ".gitignore", "node_modules/\nbig/\n**/.continue/.env\n");
  write(root, "README.md", "# demo\n");
  write(root, "old/.aider.llm.history", "old raw log\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  git(root, "rm", "-q", "--cached", "old/.aider.llm.history");
  fs.rmSync(path.join(root, "old"), { recursive: true });
  // Tracked leaks.
  write(root, ".aider.chat.history.md", fx.AIDER_CHAT);
  write(root, ".aider.input.history", fx.AIDER_INPUT);
  write(root, ".claude/settings.local.json", fx.CLAUDE_LOCAL_SETTINGS);
  write(root, ".specstory/history/2026-10-01_session.md", fx.SPECSTORY_A);
  write(root, ".specstory/history/2026-10-02_session.md", fx.SPECSTORY_B);
  write(root, ".aider.conf.yml", fx.AIDER_CONF_NO_KEY);
  git(root, "add", "-A");
  // Committed by hand despite the global excludes (a teammate without them, or "git add -f").
  git(root, "add", "-f", ".claude/settings.local.json");
  git(root, "commit", "-q", "-m", "second");
  // Untracked files.
  write(root, "CLAUDE.local.md", fx.CLAUDE_LOCAL_MD);
  write(root, "sub/.claude/settings.local.json", "{}\n");
  write(root, "notebooks/team.chat", fx.JUPYTER_CHAT);
  write(root, "notebooks/other.chat", fx.NOT_JUPYTER_CHAT);
  write(root, "weird dir/naïve (1).chat", fx.JUPYTER_CHAT);
  write(root, ".continue/.env", fx.CONTINUE_ENV);
  write(root, "pkg/package.json", JSON.stringify({ name: "demo-pkg", version: "1.0.0" }, null, 2) + "\n");
  write(root, "pkg/.npmignore", "test/\n");
  write(root, "pkg/.aider.input.history", fx.AIDER_INPUT);
  write(root, "svc/Dockerfile", "FROM node:20\nWORKDIR /app\nCOPY . /app\n");
  write(root, "svc/.dockerignore", "node_modules\n");
  write(root, "svc/CLAUDE.local.md", "svc notes\n");
  write(root, "py/pyproject.toml", "[build-system]\nrequires = [\"setuptools>=64\"]\nbuild-backend = \"setuptools.build_meta\"\n");
  write(root, "py/MANIFEST.in", "global-include *.md\n");
  write(root, "py/CLAUDE.local.md", "py notes\n");
  write(root, "node_modules/x/.aider.chat.history.md", fx.AIDER_CHAT);
  write(root, "big/.aider.chat.history.md", "x".repeat(5 * 1024 * 1024) + "\n" + fx.KEYS.github + "\n");
  fs.mkdirSync(path.join(root, "link"));
  fs.symlinkSync(path.join(outsideDir, "CLAUDE.local.md"), path.join(root, "link", "CLAUDE.local.md"));
  // Hostile repository config: fsmonitor and hooks would write a marker if git ran them.
  const hook = path.join(base, "hook-" + name + ".sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(hook, 0o755);
  fs.appendFileSync(path.join(root, ".git", "config"), `[core]\n\tfsmonitor = ${hook}\n\thooksPath = ${base}\n`);
  return root;
}

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
fs.writeFileSync(
  settingsPath,
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "extensions.autoUpdate": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.startupEditor": "none",
    "files.hotExit": "off",
    "window.restoreWindows": "none",
    "window.newWindowDimensions": "maximized",
    "window.title": TITLE + " ${rootName}",
    "workbench.sideBar.location": "left",
    "git.enabled": false,
    "git.autoRepositoryDetection": false,
  }, null, 2)
);

const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const markerDir = path.join(base, "markers");
fs.mkdirSync(markerDir);
const shot = path.join(base, "chatleak-panel.png");

function raiseOwnWindow() {
  try {
    const ids = execFileSync("xdotool", ["search", "--name", TITLE]).toString().trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      try {
        execFileSync("xdotool", ["windowraise", id]);
      } catch (_) {
        /* window gone */
      }
    }
  } catch (_) {
    /* xdotool missing or no match: capture as is */
  }
}

/** Raise the test window and capture the display; retry when the capture is blank. */
function screenshot() {
  const display = process.env.DISPLAY || ":99";
  for (let attempt = 1; attempt <= 5; attempt++) {
    raiseOwnWindow();
    try {
      execFileSync("xdotool", ["mousemove", "1590", "990"]);
    } catch (_) {
      /* no xdotool */
    }
    execFileSync("sleep", ["1"]);
    try {
      execFileSync("import", ["-window", "root", "-display", display, shot]);
      const sd = Number(execFileSync("convert", [shot, "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"]).toString());
      console.log(`screenshot: ${shot} (attempt ${attempt}, contrast ${sd.toFixed(3)})`);
      if (sd > 0.05) return;
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
  }
}

async function launch(mode, extraArgs) {
  const root = makeWorkspace("ws-" + mode);
  fs.writeFileSync(cfgFile, JSON.stringify({ mode, root, outsideDir, resultFile, markerDir, marker }));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    root,
  ];
  console.log("code " + args.join(" "));
  const env = Object.assign({}, process.env, { CL_TEST_CONFIG: cfgFile, HOME: fakeHome });
  delete env.XDG_CONFIG_HOME;
  const child = spawn("code", args, { stdio: "inherit", env });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(markerDir, "shot-" + mode);
    if (fs.existsSync(want)) {
      fs.unlinkSync(want);
      screenshot();
      fs.writeFileSync(path.join(markerDir, "shot-done-" + mode), "1");
    }
  }, 300);
  const code = await done;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", code);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

(async () => {
  const r1 = await launch("trusted", ["--disable-workspace-trust"]);

  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  s["security.workspace.trust.enabled"] = true;
  s["security.workspace.trust.startupPrompt"] = "never";
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  const r2 = await launch("untrusted", []);

  const passed = r1.passed + r2.passed;
  const failed = r1.failed + r2.failed;
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed})`);
  console.log("artifacts: " + base);
  process.exit(failed ? 1 : 0);
})();
