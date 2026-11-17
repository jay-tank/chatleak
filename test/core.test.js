"use strict";

// Unit tests for core.js: node test/core.test.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const core = require("../core");
const data = require("../data");
const fx = require("./fixtures");

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(() => passed++, (e) => {
        failed++;
        console.log("FAIL " + name + "\n  " + (e && e.message ? e.message : e));
      }));
      return;
    }
    passed++;
  } catch (e) {
    failed++;
    console.log("FAIL " + name + "\n  " + (e && e.message ? e.message.split("\n").join("\n  ") : e));
  }
}

const allSecretValues = Object.values(fx.KEYS);
function noSecretIn(obj) {
  const s = JSON.stringify(obj);
  for (const v of allSecretValues) assert.ok(!s.includes(v.slice(-12)), "secret value leaked into output");
}

// ---------------------------------------------------------------------------------------------
// classifyPath
// ---------------------------------------------------------------------------------------------

test("classify: Aider files", () => {
  assert.strictEqual(core.classifyPath(".aider.chat.history.md").entry.id, "aider-chat");
  assert.strictEqual(core.classifyPath("sub/.aider.input.history").entry.id, "aider-input");
  assert.strictEqual(core.classifyPath(".aider.llm.history").entry.id, "aider-llm");
  assert.strictEqual(core.classifyPath(".aider.conf.yml").entry.id, "aider-conf");
  const t = core.classifyPath("a/.aider.tags.cache.v4/cache.db");
  assert.strictEqual(t.entry.id, "aider-tags");
  assert.strictEqual(t.subject, "a/.aider.tags.cache.v4");
  assert.strictEqual(core.classifyPath(".aider.tags.cache.v3/x").subject, ".aider.tags.cache.v3");
});
test("classify: SpecStory aggregates to the history folder", () => {
  const c = core.classifyPath("app/.specstory/history/2026-10-01_chat.md");
  assert.strictEqual(c.entry.id, "specstory");
  assert.strictEqual(c.subject, "app/.specstory/history");
  assert.strictEqual(core.classifyPath(".specstory/.what-is-this.md"), null);
  assert.strictEqual(core.classifyPath(".specstory/history"), null, "the folder itself is not a file");
});
test("classify: Claude Code, Continue, Jupyter", () => {
  assert.strictEqual(core.classifyPath(".claude/settings.local.json").entry.id, "claude-settings-local");
  assert.strictEqual(core.classifyPath("pkg/.claude/settings.local.json").entry.id, "claude-settings-local");
  assert.strictEqual(core.classifyPath("CLAUDE.local.md").entry.id, "claude-local-md");
  assert.strictEqual(core.classifyPath(".continue/.env").entry.id, "continue-env");
  assert.strictEqual(core.classifyPath("notebooks/team.chat").entry.id, "jupyter-chat");
});
test("classify: negatives", () => {
  for (const p of [
    ".claude/settings.json", "CLAUDE.md", "AGENTS.md", ".continue/config.yaml", ".continue/rules/a.md", ".env",
    "aider.chat.history.md", ".aider.chat.history.md.bak", "docs/.aider.md", ".chat", "x.chatx", "settings.local.json",
    "node_modules/x/.aider.chat.history.md", ".cursor/rules/a.mdc", ".specstory/cursor_rules_backups/a.mdc",
    "../.aider.chat.history.md", "/abs/.aider.input.history", "a/../CLAUDE.local.md",
  ]) {
    assert.strictEqual(core.classifyPath(p), null, p);
  }
});
test("content gates: aider conf only with a key, jupyter only with chat JSON", () => {
  const conf = data.ENTRIES.find((e) => e.id === "aider-conf");
  assert.ok(core.contentMatches(conf, fx.AIDER_CONF_WITH_KEY));
  assert.ok(!core.contentMatches(conf, fx.AIDER_CONF_NO_KEY));
  assert.ok(!core.contentMatches(conf, "openai-api-key: # comment\n"));
  const jc = data.ENTRIES.find((e) => e.id === "jupyter-chat");
  assert.ok(core.contentMatches(jc, fx.JUPYTER_CHAT));
  assert.ok(!core.contentMatches(jc, fx.NOT_JUPYTER_CHAT));
  assert.ok(!core.contentMatches(jc, undefined));
  const chat = data.ENTRIES.find((e) => e.id === "aider-chat");
  assert.ok(core.contentMatches(chat, undefined), "ungated entries always match");
});
test("every entry has a source URL and no dashes", () => {
  for (const e of data.ENTRIES) {
    assert.ok(/^https:\/\//.test(e.source), e.id);
    assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(e)), e.id);
  }
  assert.strictEqual(data.VERIFIED, "2026-10-24");
});

// ---------------------------------------------------------------------------------------------
// Globs and ignore files
// ---------------------------------------------------------------------------------------------

test("glob basics", () => {
  const m = core.compileGlob("**/.aider*");
  assert.ok(m(".aider.chat.history.md"));
  assert.ok(m("a/b/.aider.input.history"));
  assert.ok(!m("a/b/aider.x"));
  assert.ok(core.compileGlob("a/*/c")("a/b/c"));
  assert.ok(!core.compileGlob("a/*/c")("a/b/x/c"));
  assert.ok(core.compileGlob("a/**/c")("a/c"));
  assert.ok(core.compileGlob("a/**/c")("a/x/y/c"));
  assert.ok(core.compileGlob("a/**")("a/x/y"));
  assert.ok(core.compileGlob("file?.md")("file1.md"));
  assert.ok(!core.compileGlob("file?.md")("file/.md"));
  assert.ok(core.compileGlob("[ab].md")("a.md"));
  assert.ok(!core.compileGlob("[!ab].md")("a.md"));
  assert.ok(core.compileGlob("[!ab].md")("c.md"));
  assert.ok(core.compileGlob("\\*.md")("*.md"));
  assert.ok(!core.compileGlob("\\*.md")("x.md"));
});
test("glob: bracket content is literal (no regex injection)", () => {
  assert.ok(core.compileGlob("[\\]]x")("]x"));
  assert.ok(core.compileGlob("[\\\\]x")("\\x"));
  assert.ok(core.compileGlob("[[]x")("[x"));
  assert.ok(!core.compileGlob("[.*]x")("ax"));
  assert.ok(core.compileGlob("a[")("a["), "unclosed bracket is literal");
});
test("glob hardening: long and globstar-heavy patterns refused, runs collapsed", () => {
  assert.strictEqual(core.normalizeGlob("a".repeat(301)), null);
  assert.strictEqual(core.normalizeGlob("**/a/**/b/**/c/**/d/**/e"), null);
  assert.strictEqual(core.normalizeGlob("*****/x"), "**/x");
  assert.strictEqual(core.normalizeGlob("**/**/**/x"), "**/x");
  assert.ok(!core.compileGlob("**/a/**/b/**/c/**/d/**/e")("a/b/c/d/e"));
  assert.ok(core.compileGlob("**/**/**/**/**/**/x")("q/x"), "collapsed globstars stay within the limit");
});
test("glob ReDoS bomb finishes fast", () => {
  const bomb = "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b";
  const subject = "a".repeat(4000);
  const t0 = Date.now();
  assert.ok(!core.compileGlob(bomb)(subject));
  assert.ok(!core.compileGlob("**/" + "*a".repeat(60) + "b")(("a/").repeat(1000) + "a"));
  const ign = core.makeGitIgnoreMatcher([{ dir: "", text: (bomb + "\n").repeat(20) }]);
  assert.ok(!ign("x/" + "a".repeat(500), false));
  assert.ok(Date.now() - t0 < 3000, "took " + (Date.now() - t0) + "ms");
});
test("mandated bomb: **/*a*a...b against x/aaaa finishes in milliseconds", () => {
  const t0 = Date.now();
  const bomb = "**/*" + "a*".repeat(12) + "b";
  assert.ok(!core.compileGlob(bomb)("x/" + "a".repeat(40)));
  assert.ok(!core.makeExcluder([bomb])("x/" + "a".repeat(40)));
  assert.ok(!core.makeDockerIgnoreMatcher(bomb)("x/" + "a".repeat(40)));
  assert.ok(!core.makeGitIgnoreMatcher([{ dir: "", text: bomb }])("x/" + "a".repeat(40), false));
  assert.ok(Date.now() - t0 < 200, "took " + (Date.now() - t0) + "ms");
});
test("braces and excluder", () => {
  assert.deepStrictEqual(core.expandBraces("a/{b,c}/d", 0), ["a/b/d", "a/c/d"]);
  assert.deepStrictEqual(core.expandBraces("a/{b,{c,d}}", 0), ["a/b", "a/c", "a/d"]);
  assert.strictEqual(core.expandBraces("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}", 0), null, "more than 64 alternatives refused");
  assert.ok(core.compileGlob("{a,b}.md")("{a,b}.md"), "ignore-file patterns treat braces literally");
  assert.ok(!core.compileGlob("{a,b}.md")("a.md"));
  const ex = core.makeExcluder(["**/dist/**", "**/{build,out}/**"]);
  assert.ok(ex("dist/.aider.chat.history.md"));
  assert.ok(ex("x/out/CLAUDE.local.md"));
  assert.ok(ex("node_modules/a/.aider.input.history"));
  assert.ok(!ex("src/CLAUDE.local.md"));
});
test("gitignore semantics", () => {
  const m = core.makeGitIgnoreMatcher([
    { dir: "", text: "# comment\n.aider*\n/root-only.chat\nlogs/\n!keep.chat\n*.chat\n!important.chat\n\\#hash\ntrail   \n" },
    { dir: "sub", text: "!.aider.input.history\nlocal.chat\n" },
  ]);
  assert.ok(m(".aider.chat.history.md", false));
  assert.ok(m("deep/x/.aider.chat.history.md", false));
  assert.ok(!m("sub/.aider.input.history", false), "deeper negation wins");
  assert.ok(m("root-only.chat", false));
  assert.ok(m("a/b.chat", false));
  assert.ok(!m("important.chat", false));
  assert.ok(m("logs/x.chat", false));
  assert.ok(m("logs/important.chat", false), "can not re-include under an ignored dir");
  assert.ok(m("#hash", false));
  assert.ok(m("trail", false), "trailing spaces trimmed");
  assert.ok(!m("README.md", false));
  // dir-only pattern does not match a file
  const d = core.makeGitIgnoreMatcher([{ dir: "", text: ".specstory/\n" }]);
  assert.ok(d(".specstory/history/a.md", false));
  assert.ok(!d(".specstory", false));
  // anchored pattern with a middle slash
  const a = core.makeGitIgnoreMatcher([{ dir: "", text: ".claude/settings.local.json\n" }]);
  assert.ok(a(".claude/settings.local.json", false));
  assert.ok(!a("pkg/.claude/settings.local.json", false));
  const g = core.makeGitIgnoreMatcher([{ dir: "", text: "**/.claude/settings.local.json\n" }]);
  assert.ok(g("pkg/.claude/settings.local.json", false));
});
test("documented ignore patterns cover their files", () => {
  const samples = {
    "aider-chat": "x/.aider.chat.history.md", "aider-input": ".aider.input.history", "aider-llm": ".aider.llm.history",
    "aider-tags": ".aider.tags.cache.v4", "aider-conf": ".aider.conf.yml", specstory: "a/.specstory/history",
    "claude-settings-local": "b/.claude/settings.local.json", "claude-local-md": "c/CLAUDE.local.md", "continue-env": "d/.continue/.env",
    "jupyter-chat": "my notes/[draft] team.chat",
  };
  for (const e of data.ENTRIES) {
    const subj = samples[e.id];
    assert.ok(subj, e.id);
    const line = core.gitignoreLineFor(e, subj);
    const m = core.makeGitIgnoreMatcher([{ dir: "", text: line + "\n" }]);
    assert.ok(m(subj, e.aggregate === "dir"), `${e.id}: ${line}`);
    assert.ok(m(subj + (e.aggregate === "dir" ? "/f.md" : ""), false), `${e.id} member`);
  }
  assert.strictEqual(core.gitignoreLineFor(data.ENTRIES.find((e) => e.id === "jupyter-chat"), "my notes/[draft] team.chat"), "/my notes/\\[draft\\] team.chat");
  assert.strictEqual(core.ignoreEscape("#x"), "\\#x");
  assert.strictEqual(core.ignoreEscape("!x "), "\\!x\\ ");
});
test("dockerignore semantics", () => {
  const m = core.makeDockerIgnoreMatcher("# c\n.aider*\n/docs\n**/*.chat\n!docs/keep.md\n");
  assert.ok(m(".aider.chat.history.md"));
  assert.ok(!m("sub/.aider.chat.history.md"), "docker patterns are anchored at the context root");
  assert.ok(m("docs/a.md"));
  assert.ok(!m("docs/keep.md"), "docker can re-include");
  assert.ok(m("x/y/z.chat"));
  assert.ok(!core.makeDockerIgnoreMatcher("")("a"));
});

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

function view(obj, gitIgnored) {
  return { texts: new Map(Object.entries(obj)), gitIgnored };
}

test("npm: no files field and nothing ignores it -> included", () => {
  const v = view({ "package.json": JSON.stringify({ name: "x", version: "1.0.0" }) });
  const r = core.npmIncludes("", v.texts.get("package.json"), ".aider.chat.history.md", v);
  assert.ok(r.included);
  assert.ok(/no "files" field/.test(r.reason));
});
test("npm: .gitignore used when .npmignore is missing", () => {
  const v = view({ "package.json": JSON.stringify({ name: "x" }), ".gitignore": ".aider*\n" });
  assert.ok(!core.npmIncludes("", v.texts.get("package.json"), ".aider.chat.history.md", v).included);
});
test("npm: .npmignore replaces .gitignore", () => {
  const v = view({ "package.json": JSON.stringify({ name: "x" }), ".gitignore": ".aider*\n", ".npmignore": "test/\n" });
  const r = core.npmIncludes("", v.texts.get("package.json"), ".aider.chat.history.md", v);
  assert.ok(r.included);
  assert.ok(/\.npmignore does not exclude/.test(r.reason));
});
test("npm: files field", () => {
  const pkg = JSON.stringify({ name: "x", files: ["dist", "*.md"] });
  const v = view({ "package.json": pkg });
  assert.ok(!core.npmIncludes("", pkg, "CLAUDE.local.md", v).included === false, "*.md includes CLAUDE.local.md");
  assert.ok(core.npmIncludes("", pkg, "CLAUDE.local.md", v).included);
  assert.ok(!core.npmIncludes("", pkg, ".aider.input.history", v).included);
  assert.ok(core.npmIncludes("", JSON.stringify({ name: "x", files: ["dist"] }), "dist/.aider.chat.history.md", v).included);
  assert.ok(!core.npmIncludes("", JSON.stringify({ name: "x", files: ["dist", "!dist/.aider*"] }), "dist/.aider.chat.history.md", v).included);
});
test("npm: private or nameless packages are skipped", () => {
  const v = view({});
  assert.strictEqual(core.npmIncludes("", JSON.stringify({ name: "x", private: true }), "CLAUDE.local.md", v), null);
  assert.strictEqual(core.npmIncludes("", JSON.stringify({ version: "1" }), "CLAUDE.local.md", v), null);
  assert.strictEqual(core.npmIncludes("", "{not json", "CLAUDE.local.md", v), null);
});
test("python: MANIFEST.in graft / global-include / exclude", () => {
  const v = view({ "pyproject.toml": "[build-system]\nrequires = [\"setuptools\"]\nbuild-backend = \"setuptools.build_meta\"\n", "MANIFEST.in": "graft docs\nglobal-include *.md\nexclude CLAUDE.local.md\n" });
  assert.ok(core.pythonSdistIncludes("", ".aider.chat.history.md", v, false).included);
  assert.ok(!core.pythonSdistIncludes("", "CLAUDE.local.md", v, false).included);
  assert.ok(core.pythonSdistIncludes("", "docs/.aider.input.history", v, false).included);
  assert.ok(!core.pythonSdistIncludes("", ".aider.input.history", v, false).included);
});
test("python: recursive-include and prune", () => {
  const cmds = core.parseManifestIn("recursive-include . *.md \\\n  *.history\nprune .specstory\n# comment\n");
  assert.deepStrictEqual(cmds.map((c) => c.cmd), ["recursive-include", "prune"]);
  assert.ok(core.manifestDecides(cmds, "x/.aider.input.history", false));
  assert.ok(!core.manifestDecides(cmds, ".specstory/history/a.md", false));
});
test("python: setuptools-scm adds tracked files", () => {
  const v = view({ "pyproject.toml": "[build-system]\nrequires = [\"setuptools>=64\", \"setuptools-scm>=8\"]\nbuild-backend = \"setuptools.build_meta\"\n" });
  const r = core.pythonSdistIncludes("", ".aider.chat.history.md", v, true);
  assert.ok(r.included && /setuptools-scm/.test(r.reason));
  assert.ok(!core.pythonSdistIncludes("", ".aider.chat.history.md", v, false).included);
  assert.ok(!core.pythonSdistIncludes("", ".aider.chat.history.md", v, null).included, "unknown tracking: not claimed");
});
test("python: hatchling uses .gitignore, include and exclude", () => {
  const base = "[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n";
  let v = view({ "pyproject.toml": base }, () => false);
  assert.ok(core.pythonSdistIncludes("", ".aider.chat.history.md", v, null).included);
  v = view({ "pyproject.toml": base }, (p) => p.startsWith(".aider"));
  assert.ok(!core.pythonSdistIncludes("", ".aider.chat.history.md", v, null).included);
  v = view({ "pyproject.toml": base + "\n[tool.hatch.build.targets.sdist]\ninclude = [\n  \"src\",\n  \"README.md\",\n]\n" }, () => false);
  assert.ok(!core.pythonSdistIncludes("", ".aider.chat.history.md", v, null).included);
  assert.ok(core.pythonSdistIncludes("", "src/CLAUDE.local.md", v, null).included);
  v = view({ "pyproject.toml": base + "\n[tool.hatch.build]\nexclude = [\".aider*\"]\n[tool.other]\nx = 1\n" }, () => false);
  assert.ok(!core.pythonSdistIncludes("", ".aider.chat.history.md", v, null).included);
  const info = core.parsePyproject(base + "\n[tool.hatch.build]\nignore-vcs = true\n");
  assert.ok(info.hatch.ignoreVcs);
});
test("python: pyproject parsing is linear on blank lines and unclosed arrays (ReDoS)", () => {
  const base = "[build-system]\nrequires = [\"hatchling\"]\nbuild-backend = \"hatchling.build\"\n";
  for (const body of ["\n".repeat(100000), "\n ".repeat(50000), "include = [\n".repeat(9000), "requires = [\n".repeat(8000), "  \t".repeat(30000) + "x"]) {
    const t0 = Date.now();
    core.parsePyproject("[tool.hatch.build]\n" + body + "x");
    core.parsePyproject(body);
    assert.ok(Date.now() - t0 < 200, "took " + (Date.now() - t0) + " ms");
  }
  // Same results as before: indented keys, multi-line arrays, \r\n line ends.
  const info = core.parsePyproject(base.replace(/\n/g, "\r\n") + "\r\n  [tool.hatch.build]\r\n  include = [\r\n \"src\",\r\n]\r\n\tignore-vcs = true\r\nonly-include = ['a', \"b\"]\r\n");
  assert.strictEqual(info.backend, "hatchling.build");
  assert.deepStrictEqual(info.hatch.include, ["src"]);
  assert.deepStrictEqual(info.hatch.onlyInclude, ["a", "b"]);
  assert.ok(info.hatch.ignoreVcs);
  assert.ok(core.parsePyproject("[build-system]\nrequires = [\n  \"setuptools\",\n  \"setuptools-scm>=8\",\n]\n").scm);
  assert.deepStrictEqual(core.parsePyproject("[tool.hatch.build]\ninclude = [\"a\"\n").hatch.include, []);
});
test("ignore files and MANIFEST.in: linear on whitespace runs and continuations (ReDoS)", () => {
  for (const [label, fn] of [
    ["gitignore spaces", () => core.parseIgnore(" ".repeat(1000000) + "x", "git")],
    ["gitignore tabs", () => core.makeGitIgnoreMatcher([{ dir: "", text: "\t".repeat(1000000) + "!" }])("a", false)],
    ["MANIFEST.in continuations", () => core.parseManifestIn("\\\n".repeat(500000))],
    ["dockerignore ../ chain", () => core.makeDockerIgnoreMatcher("../".repeat(300000) + "x\n" + "./.".repeat(300000))("a/b")],
    ["COPY ../ chain", () => core.dockerCopies(["../".repeat(300000) + "x", "./.".repeat(300000)], "a/b")],
  ]) {
    const t0 = Date.now();
    fn();
    assert.ok(Date.now() - t0 < 500, label + " took " + (Date.now() - t0) + " ms");
  }
  // Same trailing-space rule as git: unescaped trailing blanks dropped, an escaped one kept.
  assert.deepStrictEqual(["a   ", "a\\ ", "a\\  \t", "\\ ", "   ", "x"].map((l) => core.parseIgnore(l, "git").map((r) => r.raw)), [["a"], ["a\\ "], ["a\\ "], ["\\ "], [], ["x"]]);
  assert.deepStrictEqual(core.parseManifestIn("include a \\\n  b # x\nexclude d\n"), [{ cmd: "include", args: ["a", "b"] }, { cmd: "exclude", args: ["d"] }]);
});
test("git: hardened env drops every inherited GIT_* variable", () => {
  const saved = Object.assign({}, process.env);
  process.env.GIT_EXEC_PATH = "/tmp/evil";
  process.env.GIT_CONFIG_KEY_0 = "core.pager";
  process.env.git_attr_source = "HEAD";
  process.env.GIT_PROXY_COMMAND = "/tmp/evil";
  try {
    const env = core.hardenedEnv();
    for (const k of ["GIT_EXEC_PATH", "GIT_CONFIG_KEY_0", "git_attr_source", "GIT_PROXY_COMMAND", "GIT_DIR"]) assert.ok(!(k in env), k);
    assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.strictEqual(env.GIT_LITERAL_PATHSPECS, "1");
    assert.strictEqual(env.PATH, process.env.PATH);
  } finally {
    for (const k of ["GIT_EXEC_PATH", "GIT_CONFIG_KEY_0", "git_attr_source", "GIT_PROXY_COMMAND"]) if (!(k in saved)) delete process.env[k];
  }
});
test("python: unsupported backends return null", () => {
  const v = view({ "pyproject.toml": "[build-system]\nrequires = [\"poetry-core\"]\nbuild-backend = \"poetry.core.masonry.api\"\n" });
  assert.strictEqual(core.pythonSdistIncludes("", ".aider.chat.history.md", v, true), null);
});
test("docker: COPY . without .dockerignore", () => {
  const v = view({ Dockerfile: "FROM node:20\nWORKDIR /app\nCOPY package.json ./\nCOPY . .\n" });
  const r = core.dockerIncludes("Dockerfile", ".aider.chat.history.md", v);
  assert.ok(r.included);
  assert.strictEqual(r.ignoreFile, ".dockerignore");
  assert.ok(/no \.dockerignore/.test(r.reason));
});
test("docker: .dockerignore and Dockerfile-specific ignore", () => {
  let v = view({ Dockerfile: "FROM x\nCOPY . /app\n", ".dockerignore": ".aider*\n" });
  assert.ok(!core.dockerIncludes("Dockerfile", ".aider.chat.history.md", v).included);
  v = view({ "build.Dockerfile": "FROM x\nCOPY . /app\n", ".dockerignore": ".aider*\n", "build.Dockerfile.dockerignore": "node_modules\n" });
  const r = core.dockerIncludes("build.Dockerfile", ".aider.chat.history.md", v);
  assert.ok(r.included, "the Dockerfile-specific ignore wins");
  assert.strictEqual(r.ignoreFile, "build.Dockerfile.dockerignore");
});
test("docker: only copied paths, --from skipped, outside context null", () => {
  const v = view({ "svc/Dockerfile": "FROM x AS b\nCOPY --from=b . /x\nCOPY --chown=1:1 src/ /app/src\nADD [\"conf\", \"/etc/conf\"]\nRUN echo \\\n  hi\n" });
  assert.ok(core.dockerIncludes("svc/Dockerfile", "svc/src/.aider.chat.history.md", v).included);
  assert.ok(core.dockerIncludes("svc/Dockerfile", "svc/conf/CLAUDE.local.md", v).included);
  assert.ok(!core.dockerIncludes("svc/Dockerfile", "svc/.aider.chat.history.md", v).included);
  assert.strictEqual(core.dockerIncludes("svc/Dockerfile", "other/.aider.chat.history.md", v), null);
  assert.deepStrictEqual(core.parseDockerCopySources("COPY --from=builder /a /b\nCOPY https://x/y /z\nCOPY a b c/\n"), ["a", "b"]);
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

test("secrets in an Aider transcript are found, masked and located", () => {
  const s = core.findSecrets(fx.AIDER_CHAT);
  assert.deepStrictEqual(s.map((x) => x.kind), ["openai-project", "github"]);
  assert.strictEqual(s[0].line, 6);
  assert.strictEqual(s[0].character, "    export OPENAI_API_KEY=".length);
  assert.strictEqual(s[0].endCharacter - s[0].character, fx.KEYS.openaiProject.length);
  assert.strictEqual(s[0].masked, `sk-proj-**** (${fx.KEYS.openaiProject.length} chars)`);
  assert.strictEqual(s[1].masked, "ghp_**** (40 chars)");
  noSecretIn(s);
});
test("each provider pattern matches", () => {
  const expect = { anthropic: "anthropic", google: "google", github: "github", aws: "aws", openrouter: "openrouter", groq: "groq", hf: "huggingface", openaiProject: "openai-project" };
  for (const [k, kind] of Object.entries(expect)) {
    const s = core.findSecrets("token: " + fx.KEYS[k] + "\n");
    assert.strictEqual(s.length, 1, k);
    assert.strictEqual(s[0].kind, kind, k);
    noSecretIn(s);
  }
  const pk = core.findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
  assert.strictEqual(pk[0].kind, "private-key");
});
test("secret false positives", () => {
  const negatives = [
    "sk-" + "proj-" + "x".repeat(60),
    "OPENAI_API_KEY=sk-" + "proj-your-key-here-" + "a".repeat(30),
    "AKIA" + "IOSFODNN7EXAMPLE",
    "sk-" + "ant-api03-" + "EXAMPLE".repeat(14),
    "the sk-learn library and task-ant-colony",
    "ghp_" + "0".repeat(36),
    "AIza" + "...".repeat(12),
    "use ${OPENAI_API_KEY} or <your key>",
    "risk-" + "proj-" + fx.fake("", 60, 99),
    "hf_hub_download(repo_id='x')",
  ];
  for (const n of negatives) assert.deepStrictEqual(core.findSecrets(n), [], n);
  assert.deepStrictEqual(core.findSecrets(""), []);
  assert.deepStrictEqual(core.findSecrets(null), []);
});
test("generic assignments only when asked, not for low entropy", () => {
  const t = fx.CLAUDE_LOCAL_SETTINGS;
  assert.strictEqual(core.findSecrets(t).length, 0);
  const g = core.findSecrets(t, { generic: true });
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].kind, "generic");
  assert.ok(/^"INTERNAL_API_TOKEN" value$/.test(g[0].label), g[0].label);
  noSecretIn(g);
  assert.deepStrictEqual(core.findSecrets("password: aaaaaaaaaaaaaaaaaaaaaaaaaaaa\napi_key = some_function_name_here\n", { generic: true }), []);
});
test("secret count is capped", () => {
  const many = Array.from({ length: 200 }, (_, i) => fx.fake("gh" + "p_", 36, 1000 + i)).join("\n");
  assert.strictEqual(core.findSecrets(many).length, 50);
});

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

const E = (id) => data.ENTRIES.find((e) => e.id === id);

test("CL001 committed transcript with secrets: row names the file and count", () => {
  const secrets = core.findSecrets(fx.AIDER_CHAT).map((s) => Object.assign({ file: ".aider.chat.history.md" }, s));
  const f = core.buildFindings([{ subject: ".aider.chat.history.md", entry: E("aider-chat"), onDisk: true, tracked: true, repoIgnored: false, secrets }], [], {});
  const cl1 = f.find((x) => x.rule === "CL001");
  assert.strictEqual(cl1.label, ".aider.chat.history.md is committed (contains 2 secret-like strings)");
  assert.strictEqual(cl1.severity, "error");
  assert.deepStrictEqual(cl1.fixes.map((x) => x.type), ["untrack", "ignore"]);
  assert.strictEqual(cl1.fixes[1].line, ".aider*");
  const cl3 = f.filter((x) => x.rule === "CL003");
  assert.strictEqual(cl3.length, 2);
  assert.ok(/^OpenAI project key sk-proj-\*\*\*\* \(\d+ chars\) on line 7$/.test(cl3[0].label), cl3[0].label);
  assert.ok(!f.some((x) => x.rule === "CL002"), "tracked: no CL002");
  noSecretIn(f);
});
test("CL001 already ignored: only untrack fix; SpecStory is information", () => {
  let f = core.buildFindings([{ subject: ".aider.input.history", entry: E("aider-input"), onDisk: true, tracked: true, repoIgnored: true, secrets: [] }], [], {});
  assert.deepStrictEqual(f[0].fixes.map((x) => x.type), ["untrack"]);
  f = core.buildFindings([{ subject: ".specstory/history", entry: E("specstory"), isDir: true, trackedCount: 3, onDisk: true, tracked: true, repoIgnored: false, secrets: [] }], [], {});
  assert.strictEqual(f[0].severity, "information");
  assert.strictEqual(f[0].label, ".specstory/history is committed (3 files)");
  assert.strictEqual(f[0].file, null, "no diagnostic file for a folder");
  assert.ok(/SpecStory suggests versioning/.test(f[0].message));
  f = core.buildFindings([{ subject: ".specstory/history", entry: E("specstory"), isDir: true, onDisk: true, tracked: true, repoIgnored: false, secrets: [] }], [], { CL001: "warning" });
  assert.strictEqual(f[0].severity, "warning", "user override wins");
});
test("CL002 untracked and not ignored; local-only excludes are information", () => {
  let f = core.buildFindings([{ subject: "CLAUDE.local.md", entry: E("claude-local-md"), onDisk: true, tracked: false, repoIgnored: false, localIgnored: false, secrets: [] }], [], {});
  assert.strictEqual(f[0].rule, "CL002");
  assert.strictEqual(f[0].label, "CLAUDE.local.md is not in .gitignore");
  assert.strictEqual(f[0].severity, "warning");
  assert.strictEqual(f[0].fixes[0].line, "CLAUDE.local.md");
  f = core.buildFindings([{ subject: ".claude/settings.local.json", entry: E("claude-settings-local"), onDisk: true, tracked: false, repoIgnored: false, localIgnored: true, secrets: [] }], [], {});
  assert.strictEqual(f[0].label, ".claude/settings.local.json is only ignored by your local git excludes");
  assert.strictEqual(f[0].severity, "information");
  f = core.buildFindings([{ subject: "CLAUDE.local.md", entry: E("claude-local-md"), onDisk: true, tracked: false, repoIgnored: true, secrets: [] }], [], {});
  assert.strictEqual(f.length, 0, "ignored and untracked: nothing");
  f = core.buildFindings([{ subject: ".specstory/history", entry: E("specstory"), isDir: true, onDisk: true, tracked: false, repoIgnored: false, secrets: [] }], [], {});
  assert.strictEqual(f.length, 0, "SpecStory recommends versioning: no CL002");
  f = core.buildFindings([{ subject: "CLAUDE.local.md", entry: E("claude-local-md"), onDisk: true, tracked: null, repoIgnored: false, secrets: [] }], [], {});
  assert.strictEqual(f[0].rule, "CL002", "untrusted: still CL002");
});
test("CL004 local settings committed", () => {
  const f = core.buildFindings([{ subject: ".claude/settings.local.json", entry: E("claude-settings-local"), onDisk: true, tracked: true, repoIgnored: false, secrets: [] }], [], {});
  assert.strictEqual(f[0].rule, "CL004");
  assert.strictEqual(f[0].label, ".claude/settings.local.json is committed (local-only personal project settings)");
  assert.strictEqual(f[0].fixes[1].line, "**/.claude/settings.local.json");
});
test("CL005 exposures", () => {
  const f = core.buildFindings([{ subject: ".aider.chat.history.md", entry: E("aider-chat"), onDisk: true, tracked: false, repoIgnored: true, secrets: [], exposures: [
    { kind: "npm", via: "package.json", reason: "x", fix: { file: ".npmignore", line: ".aider*" } },
    { kind: "docker", via: "Dockerfile", reason: "y", fix: { file: ".dockerignore", line: ".aider.chat.history.md" } },
    { kind: "python", via: "MANIFEST.in", reason: "z" },
  ] }], [], {});
  assert.deepStrictEqual(f.map((x) => x.label), [
    ".aider.chat.history.md ships in the npm package",
    ".aider.chat.history.md is copied into the Docker image",
    ".aider.chat.history.md ships in the Python sdist",
  ]);
  assert.strictEqual(f[0].fixes[0].file, ".npmignore");
  assert.strictEqual(f[2].fixes.length, 0);
});
test("CL006 history and rule off", () => {
  const added = new Map([[".aider.chat.history.md", 2], ["src/a.js", 1], [".specstory/history/a.md", 1], [".specstory/history/b.md", 3], ["CLAUDE.local.md", 1]]);
  const h = core.historyCandidates(added, new Set(["src/a.js", "CLAUDE.local.md"]));
  assert.deepStrictEqual(h.map((x) => [x.path, x.count]), [[".aider.chat.history.md", 2], [".specstory/history", 3]]);
  const f = core.buildFindings([], h, {});
  assert.strictEqual(f[0].label, ".aider.chat.history.md is in past commits (added in 2 commits)");
  assert.strictEqual(f[0].severity, "information");
  assert.ok(/never rewrites history/.test(f[0].message));
  assert.strictEqual(core.buildFindings([], h, { CL006: "off" }).length, 0);
  const h2 = core.historyCandidates(added, new Set([".specstory/history/a.md"]));
  assert.ok(!h2.some((x) => x.path === ".specstory/history"), "partly tracked folder is covered by CL001");
});
test("weird names are displayed escaped", () => {
  const f = core.buildFindings([{ subject: "a\nb/CLAUDE.local.md", entry: E("claude-local-md"), onDisk: true, tracked: false, repoIgnored: false, secrets: [] }], [], {});
  assert.ok(f[0].label.startsWith("a\\nb/CLAUDE.local.md"));
});
test("sanitizeRuleOverrides", () => {
  assert.deepStrictEqual(core.sanitizeRuleOverrides({ CL001: "warning", CL002: "bogus", XX: "error" }), { CL001: "warning" });
  assert.deepStrictEqual(core.sanitizeRuleOverrides(null), {});
  assert.deepStrictEqual(core.sanitizeRuleOverrides(["CL001"]), {});
});
test("resolveGlobalExcludesFile", () => {
  const files = { "/h/.gitconfig": "[user]\n name = x\n[core]\n\texcludesfile = ~/.gitignore_global\n" };
  assert.strictEqual(core.resolveGlobalExcludesFile({}, "/h", (p) => files[p] || null), path.join("/h", ".gitignore_global"));
  assert.strictEqual(core.resolveGlobalExcludesFile({}, "/h", () => null), null);
  assert.strictEqual(core.resolveGlobalExcludesFile({}, "/h", () => "[core]\nexcludesfile = relative/path\n"), null);
});
test("isSafeRelPath", () => {
  for (const ok of ["a", "a/b.md", ".aider.chat.history.md", "weird name/naïve (1).md"]) assert.ok(core.isSafeRelPath(ok), ok);
  for (const bad of ["", "/a", "../a", "a/../b", "a//b", "C:/x", "a\\b", ".git/config", "a/.GIT/x", "a\0b", "./a"]) assert.ok(!core.isSafeRelPath(bad), bad);
});

// ---------------------------------------------------------------------------------------------
// Git (real repositories in a private temp dir)
// ---------------------------------------------------------------------------------------------

function gitAvailable() {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch (_) {
    return false;
  }
}

if (gitAvailable()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatleak-unit-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: repo, env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }) });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, ".aider.chat.history.md"), "old transcript\n");
  fs.writeFileSync(path.join(repo, "a.js"), "x\n");
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "CLAUDE.local.md"), "notes\n");
  fs.writeFileSync(path.join(repo, "weird name.chat"), "{}\n");
  g("add", "-A");
  g("commit", "-q", "-m", "one");
  g("rm", "-q", "--cached", ".aider.chat.history.md");
  g("commit", "-q", "-m", "two");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.md\n");
  fs.writeFileSync(path.join(repo, "ignored.md"), "x\n");
  // Hostile repository config: an fsmonitor hook that would write a marker if git ran it.
  const marker = path.join(tmp, "PWNED");
  const hook = path.join(tmp, "hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(hook, 0o755);
  fs.appendFileSync(path.join(repo, ".git", "config"), `[core]\n\tfsmonitor = ${hook}\n\thooksPath = ${tmp}\n[alias]\n\tls-files = !touch '${marker}'\n`);

  test("git: prefix, ls-files, check-ignore, log, rm --cached (hostile config ignored)", async () => {
    assert.strictEqual(await core.gitPrefix("git", repo), "");
    assert.strictEqual(await core.gitPrefix("git", path.join(repo, "sub")), "sub/");
    assert.strictEqual(await core.gitPrefix("git", tmp), null);
    const ls = await core.gitLsFiles("git", repo);
    assert.deepStrictEqual(ls.files.sort(), ["a.js", "sub/CLAUDE.local.md", "weird name.chat"]);
    const lsSub = await core.gitLsFiles("git", path.join(repo, "sub"));
    assert.deepStrictEqual(lsSub.files, ["CLAUDE.local.md"]);
    const ign = await core.gitCheckIgnore("git", repo, ["ignored.md", ".aider.chat.history.md", "a.js"], null);
    assert.deepStrictEqual([...ign], ["ignored.md"]);
    const none = await core.gitCheckIgnore("git", repo, ["a.js"], null);
    assert.strictEqual(none.size, 0);
    const excl = path.join(tmp, "global-excludes");
    fs.writeFileSync(excl, ".aider*\n");
    const ign2 = await core.gitCheckIgnore("git", repo, [".aider.chat.history.md"], excl);
    assert.deepStrictEqual([...ign2], [".aider.chat.history.md"]);
    const log = await core.gitLogAdded("git", repo);
    assert.strictEqual(log.added.get(".aider.chat.history.md"), 1);
    const hist = core.historyCandidates(log.added, new Set(ls.files));
    assert.deepStrictEqual(hist.map((h) => h.path), [".aider.chat.history.md"]);
    const rm = await core.gitRmCached("git", repo, "sub/CLAUDE.local.md", false);
    assert.ok(rm.ok, rm.stderr);
    assert.ok(fs.existsSync(path.join(repo, "sub", "CLAUDE.local.md")), "file kept on disk");
    const ls2 = await core.gitLsFiles("git", repo);
    assert.ok(!ls2.files.includes("sub/CLAUDE.local.md"));
    assert.ok(!(await core.gitRmCached("git", repo, "../x", false)).ok);
    const lit = await core.gitRmCached("git", repo, "*", false);
    assert.ok(!lit.ok, "pathspec * is literal, not a glob");
    assert.ok((await core.gitLsFiles("git", repo)).files.includes("a.js"));
    assert.ok(!fs.existsSync(marker), "fsmonitor / hooks / alias from repo config never ran");
  });
  test("git: check-ignore treats a colon name literally", async () => {
    fs.writeFileSync(path.join(repo, ":(top)ignored.md"), "x\n");
    const r = await core.gitCheckIgnore("git", repo, [":(top)ignored.md", "ignored.md"], null);
    assert.deepStrictEqual([...r], ["ignored.md"]);
  });
  test("git: output cap truncates", async () => {
    const r = await core.runGit("git", repo, ["ls-files", "-z"], { maxBytes: 3 });
    assert.ok(r.truncated && !r.ok);
  });
  test("git: missing binary does not throw", async () => {
    const r = await core.runGit(path.join(tmp, "no-such-git"), repo, ["status"]);
    assert.ok(!r.ok);
  });
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
} else {
  console.log("git not found: git tests skipped");
}

Promise.all(pending).then(() => {
  console.log(`\nunit tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
});
