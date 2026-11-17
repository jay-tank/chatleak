"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the git repository built
// by test/run-vscode.js and its JSON config in CL_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("../../core");
const fx = require("../fixtures");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label);
}
async function expectWait(name, fn, timeoutMs, detailFn) {
  try {
    await waitFor(fn, timeoutMs || 15000, name);
    check(name, true);
  } catch (e) {
    check(name, false, String(e) + (detailFn ? " :: " + detailFn() : ""));
  }
}

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.CL_TEST_CONFIG, "utf8"));
  const { mode, root, outsideDir, resultFile, markerDir, marker } = cfg;
  const trusted = mode === "trusted";
  const M = (s) => `${mode}: ${s}`;
  const P = (rel) => path.join(root, ...rel.split("/"));
  const conf = () => vscode.workspace.getConfiguration("chatLeak");

  // Expected findings: [rule, rel, labelStartsWith]
  const EXPECT = trusted
    ? [
      ["CL001", ".aider.chat.history.md", ".aider.chat.history.md is committed (contains 2 secret-like strings)"],
      ["CL003", ".aider.chat.history.md", "OpenAI project key sk-proj-****"],
      ["CL003", ".aider.chat.history.md", "GitHub token ghp_****"],
      ["CL001", ".aider.input.history", ".aider.input.history is committed"],
      ["CL004", ".claude/settings.local.json", ".claude/settings.local.json is committed (contains 1 secret-like string)"],
      ["CL003", ".claude/settings.local.json", "\"INTERNAL_API_TOKEN\" value ****"],
      ["CL003", ".continue/.env", "Google API key AIza****"],
      ["CL001", ".specstory/history", ".specstory/history is committed (2 files, 1 secret-like string)"],
      ["CL003", ".specstory/history/2026-10-01_session.md", "Anthropic API key sk-ant-****"],
      ["CL002", "CLAUDE.local.md", "CLAUDE.local.md is not in .gitignore"],
      ["CL002", "notebooks/team.chat", "notebooks/team.chat is not in .gitignore"],
      ["CL002", "pkg/.aider.input.history", "pkg/.aider.input.history is not in .gitignore"],
      ["CL005", "pkg/.aider.input.history", "pkg/.aider.input.history ships in the npm package"],
      ["CL002", "py/CLAUDE.local.md", "py/CLAUDE.local.md is not in .gitignore"],
      ["CL005", "py/CLAUDE.local.md", "py/CLAUDE.local.md ships in the Python sdist"],
      ["CL002", "sub/.claude/settings.local.json", "sub/.claude/settings.local.json is only ignored by your local git excludes"],
      ["CL002", "svc/CLAUDE.local.md", "svc/CLAUDE.local.md is not in .gitignore"],
      ["CL005", "svc/CLAUDE.local.md", "svc/CLAUDE.local.md is copied into the Docker image"],
      ["CL002", "weird dir/naïve (1).chat", "weird dir/naïve (1).chat is not in .gitignore"],
    ]
    : [
      ["CL002", ".aider.chat.history.md", ".aider.chat.history.md is not in .gitignore"],
      ["CL003", ".aider.chat.history.md", "OpenAI project key sk-proj-****"],
      ["CL003", ".aider.chat.history.md", "GitHub token ghp_****"],
      ["CL002", ".aider.input.history", ".aider.input.history is not in .gitignore"],
      ["CL002", ".claude/settings.local.json", ".claude/settings.local.json is not in .gitignore"],
      ["CL003", ".claude/settings.local.json", "\"INTERNAL_API_TOKEN\" value ****"],
      ["CL003", ".continue/.env", "Google API key AIza****"],
      ["CL003", ".specstory/history/2026-10-01_session.md", "Anthropic API key sk-ant-****"],
      ["CL002", "CLAUDE.local.md", "CLAUDE.local.md is not in .gitignore"],
      ["CL002", "notebooks/team.chat", "notebooks/team.chat is not in .gitignore"],
      ["CL002", "pkg/.aider.input.history", "pkg/.aider.input.history is not in .gitignore"],
      ["CL005", "pkg/.aider.input.history", "pkg/.aider.input.history ships in the npm package"],
      ["CL002", "py/CLAUDE.local.md", "py/CLAUDE.local.md is not in .gitignore"],
      ["CL005", "py/CLAUDE.local.md", "py/CLAUDE.local.md ships in the Python sdist"],
      ["CL002", "sub/.claude/settings.local.json", "sub/.claude/settings.local.json is not in .gitignore"],
      ["CL002", "svc/CLAUDE.local.md", "svc/CLAUDE.local.md is not in .gitignore"],
      ["CL005", "svc/CLAUDE.local.md", "svc/CLAUDE.local.md is copied into the Docker image"],
      ["CL002", "weird dir/naïve (1).chat", "weird dir/naïve (1).chat is not in .gitignore"],
    ];
  const TOTAL = EXPECT.length;
  const dump = (F) => JSON.stringify(F.map((f) => [f.rule, f.rel, f.label]));
  const secretTails = Object.values(fx.KEYS).map((k) => k.slice(-12));
  const leaksSecret = (s) => secretTails.some((t) => String(s).includes(t));

  try {
    check(M("workspace trust state"), vscode.workspace.isTrusted === trusted);
    const ext = vscode.extensions.getExtension("jaytankdev.chatleak");
    check(M("extension found"), !!ext);
    const api = ext.isActive ? ext.exports : await ext.activate();
    check(M("activate() returns the test API"), api && typeof api.getTreeItems === "function");
    await api.ready();
    await expectWait(M(`initial scan finds ${TOTAL} findings`), () => api.getFindings().length === TOTAL, 30000, () => dump(api.getFindings()));
    const F = api.getFindings();
    for (const [rule, rel, label] of EXPECT) {
      check(M(`${rule} ${rel}: "${label}"`), F.some((f) => f.rule === rule && f.rel === rel && f.label.startsWith(label)), dump(F.filter((f) => f.rel === rel)));
    }
    for (const rel of ["notebooks/other.chat", "node_modules/x/.aider.chat.history.md", "big/.aider.chat.history.md", "link/CLAUDE.local.md", ".aider.conf.yml", "README.md", "old/.aider.llm.history"]) {
      check(M(`no findings for ${rel}`), !F.some((f) => f.rel === rel || f.subject === rel));
    }
    check(M("nothing from outside the workspace"), !F.some((f) => f.uri && f.uri.fsPath.startsWith(outsideDir)));
    check(M("no secret value in any label, message or tooltip"), !F.some((f) => leaksSecret(f.label) || leaksSecret(f.message)));
    if (trusted) {
      const sp = F.find((f) => f.rule === "CL001" && f.rel === ".specstory/history");
      check(M("SpecStory history is information"), sp && sp.severity === "information");
      const loc = F.find((f) => f.rel === "sub/.claude/settings.local.json");
      check(M("global-excludes-only file is information"), loc && loc.severity === "information");
    } else {
      check(M("untrusted: no committed-file rules"), !F.some((f) => ["CL001", "CL004", "CL006"].includes(f.rule)));
    }

    // Contributions.
    const pkg = ext.packageJSON;
    const ac = (pkg.contributes.viewsContainers || {}).activitybar || [];
    check(M("activity bar container contributed"), ac.some((c) => c.id === "chatleak" && c.icon === "media/activity.svg"));
    check(M("activity bar icon file exists"), fs.existsSync(path.join(ext.extensionPath, "media", "activity.svg")));
    check(M("view chatLeak.view named AI chat leaks"), (pkg.contributes.views.chatleak || []).some((v) => v.id === "chatLeak.view" && v.name === "AI chat leaks"));
    const inline = pkg.contributes.menus["view/item/context"].filter((m) => m.group.startsWith("inline")).map((m) => m.command);
    check(M("inline actions contributed"), ["chatLeak.addToIgnore", "chatLeak.untrack", "chatLeak.showHistoryHelp"].every((c) => inline.includes(c)));
    check(M("four empty states contributed"), pkg.contributes.viewsWelcome.length === 4);
    check(M("untrustedWorkspaces limited"), pkg.capabilities.untrustedWorkspaces.supported === "limited");

    // Diagnostics, badge, status bar.
    const diag = vscode.languages.getDiagnostics(vscode.Uri.file(P(".aider.chat.history.md"))).filter((d) => d.source === "ChatLeak");
    check(M("diagnostics on the transcript"), diag.length === (trusted ? 3 : 3), String(diag.length));
    const dsec = diag.find((d) => d.code === "CL003" && /OpenAI project key/.test(d.message));
    check(M("CL003 diagnostic covers the key exactly"), dsec && dsec.range.start.line === 6 && dsec.range.start.character === "    export OPENAI_API_KEY=".length && dsec.range.end.character - dsec.range.start.character === fx.KEYS.openaiProject.length);
    check(M("CL003 is an error"), dsec && dsec.severity === vscode.DiagnosticSeverity.Error);
    check(M("no diagnostics for node_modules"), vscode.languages.getDiagnostics(vscode.Uri.file(P("node_modules/x/.aider.chat.history.md"))).length === 0);
    check(M("badge equals finding count"), api.getBadge() === TOTAL, `badge=${api.getBadge()}`);
    check(M("status bar shows ChatLeak: N"), api.getStatusText().endsWith(`ChatLeak: ${TOTAL}`), api.getStatusText());

    // Open the view container.
    let opened = true;
    try {
      await vscode.commands.executeCommand("workbench.view.extension.chatleak");
      await vscode.commands.executeCommand("chatLeak.focusView");
    } catch (e) {
      opened = String(e);
    }
    check(M("view container and focusView open"), opened === true, opened);

    // Tree rows.
    const top = await api.getTreeItems();
    const groupsExpected = new Set(EXPECT.map((e) => e[1]));
    check(M("one group per file or folder"), top.length === groupsExpected.size && top.every((t) => t.contextValue === "group"), JSON.stringify(top.map((t) => [t.label, t.description])));
    const aiderG = top.find((t) => t.label === ".aider.chat.history.md");
    check(M("group row: file name, count in description"), aiderG && aiderG.description === "3", aiderG && aiderG.description);
    const weirdG = top.find((t) => t.label === "naïve (1).chat");
    check(M("weird file name group"), weirdG && weirdG.description.startsWith("weird dir"));
    const rows = await api.getTreeItems(aiderG.node);
    check(M("rows under the transcript"), rows.length === 3, JSON.stringify(rows.map((r) => r.label)));
    const r1 = rows[0];
    check(M("first row names the file and the problem"), trusted ? r1.label === ".aider.chat.history.md is committed (contains 2 secret-like strings)" : r1.label === ".aider.chat.history.md is not in .gitignore", r1.label);
    check(M("row description has rule id and title"), /^CL00\d {2}/.test(r1.description), r1.description);
    check(M("row tooltip has message and actions"), /Actions:/.test(r1.tooltip) && /\.aider\*/.test(r1.tooltip));
    check(M("row context marks inline actions"), trusted ? r1.contextValue === "finding.ignorable.untrackable" : r1.contextValue === "finding.ignorable", r1.contextValue);
    const secRow = rows.find((r) => /OpenAI project key/.test(r.label));
    check(M("secret row masked with line"), secRow && /sk-proj-\*\*\*\* \(\d+ chars\) on line 7$/.test(secRow.label) && !leaksSecret(secRow.tooltip), secRow && secRow.label);
    check(M("rows open through chatLeak.openFinding"), rows.every((r) => r.command && r.command.command === "chatLeak.openFinding"));

    // Open a finding.
    const ok = await vscode.commands.executeCommand("chatLeak.openFinding", ...secRow.command.arguments);
    const ed = vscode.window.activeTextEditor;
    check(M("openFinding opens the transcript at the key"), ok === true && ed && ed.document.uri.fsPath === P(".aider.chat.history.md") && ed.selection.active.line === 6);
    const wrow = (await api.getTreeItems(weirdG.node))[0];
    check(M("openFinding opens the weird-named file"), (await vscode.commands.executeCommand("chatLeak.openFinding", ...wrow.command.arguments)) === true && vscode.window.activeTextEditor.document.uri.fsPath === P("weird dir/naïve (1).chat"));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Forged arguments.
    check(M("openFinding refuses a forged uid"), (await vscode.commands.executeCommand("chatLeak.openFinding", "file:///etc::CL001:x:1")) === false);
    check(M("openFinding refuses a Uri"), (await vscode.commands.executeCommand("chatLeak.openFinding", vscode.Uri.file(path.join(outsideDir, "CLAUDE.local.md")))) === false);
    check(M("openFinding refuses a fake node"), (await vscode.commands.executeCommand("chatLeak.openFinding", { type: "finding", uid: "nope" })) === false);
    check(M("no editor opened for refused arguments"), !vscode.window.activeTextEditor);
    check(M("addToIgnore refuses junk"), (await vscode.commands.executeCommand("chatLeak.addToIgnore", { type: "finding", uid: "x" })) === false);
    check(M("untrack refuses junk"), (await vscode.commands.executeCommand("chatLeak.untrack", "x")) === false);
    check(M("showHistoryHelp refuses junk"), (await vscode.commands.executeCommand("chatLeak.showHistoryHelp", "x")) === false);

    // Quick Fix through the code action provider.
    const cdoc = await vscode.workspace.openTextDocument(P("CLAUDE.local.md"));
    await vscode.window.showTextDocument(cdoc);
    await sleep(500);
    const acts = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", cdoc.uri, new vscode.Range(0, 0, 0, 1), vscode.CodeActionKind.QuickFix.value);
    const qa = (acts || []).find((a) => a.title === 'Add "CLAUDE.local.md" to .gitignore (CL002)');
    check(M("Quick Fix offered on CLAUDE.local.md"), !!qa, JSON.stringify((acts || []).map((a) => a.title)));
    if (trusted) {
      const tdoc = await vscode.workspace.openTextDocument(P(".aider.chat.history.md"));
      await vscode.window.showTextDocument(tdoc);
      await sleep(300);
      const acts2 = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", tdoc.uri, new vscode.Range(0, 0, 0, 1), vscode.CodeActionKind.QuickFix.value);
      check(M("untrack Quick Fix offered on the committed transcript"), (acts2 || []).some((a) => a.title === "Stop tracking .aider.chat.history.md in git, keep the file (CL001)") && (acts2 || []).some((a) => a.title === 'Add ".aider*" to .gitignore (CL001)'), JSON.stringify((acts2 || []).map((a) => a.title)));
    }
    if (qa) await vscode.commands.executeCommand(qa.command.command, ...qa.command.arguments);
    const gi = fs.readFileSync(P(".gitignore"), "utf8");
    check(M("Quick Fix appended CLAUDE.local.md to .gitignore"), gi === "node_modules/\nbig/\n**/.continue/.env\nCLAUDE.local.md\n", JSON.stringify(gi));
    await expectWait(M("CL002 gone for every CLAUDE.local.md"), () => !api.getFindings().some((f) => f.rule === "CL002" && /CLAUDE\.local\.md$/.test(f.rel)), 15000, () => dump(api.getFindings()));
    check(M("Docker and sdist exposure still reported"), api.getFindings().filter((f) => f.rule === "CL005" && /CLAUDE\.local\.md$/.test(f.rel)).length === 2);
    let T = TOTAL - 3;
    check(M("count after the .gitignore fix"), api.getFindings().length === T, dump(api.getFindings()));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Inline action: add to .dockerignore for the Docker exposure.
    const svcG = (await api.getTreeItems()).find((t) => t.label === "CLAUDE.local.md" && t.description.startsWith("svc"));
    const dRow = (await api.getTreeItems(svcG.node)).find((r) => /Docker image/.test(r.label));
    check(M("Docker row is ignorable"), dRow && dRow.contextValue === "finding.ignorable", dRow && dRow.contextValue);
    check(M("addToIgnore from the panel"), (await vscode.commands.executeCommand("chatLeak.addToIgnore", dRow.node)) === true);
    check(M(".dockerignore got the file"), fs.readFileSync(P("svc/.dockerignore"), "utf8") === "node_modules\nCLAUDE.local.md\n");
    await expectWait(M("Docker exposure gone"), () => !api.getFindings().some((f) => f.rel === "svc/CLAUDE.local.md"));
    T -= 1;
    check(M("stale node refused after the fix"), (await vscode.commands.executeCommand("chatLeak.addToIgnore", dRow.node)) === false);

    // Disk changes: new file picked up by rescan and by the poll fallback.
    fs.mkdirSync(P("new"), { recursive: true });
    fs.writeFileSync(P("new/.aider.input.history"), "+hi\n");
    await vscode.commands.executeCommand("chatLeak.rescan");
    await expectWait(M("rescan picks up a new transcript"), () => api.getFindings().some((f) => f.rel === "new/.aider.input.history" && f.rule === "CL002"));
    fs.rmSync(P("new"), { recursive: true });
    await sleep(50);
    await api.poll();
    await expectWait(M("poll fallback notices the deletion"), () => !api.getFindings().some((f) => f.rel === "new/.aider.input.history"));
    // Secret added to an existing transcript, picked up through the poll's mtime signature.
    await sleep(1100);
    fs.appendFileSync(P("notebooks/team.chat"), "");
    const teamText = fx.JUPYTER_CHAT.replace('"hi"', JSON.stringify("key " + fx.KEYS.hf));
    fs.writeFileSync(P("notebooks/team.chat"), teamText);
    await api.poll();
    await expectWait(M("poll fallback finds a new secret"), () => api.getFindings().some((f) => f.rel === "notebooks/team.chat" && f.rule === "CL003" && /Hugging Face/.test(f.label)));
    fs.writeFileSync(P("notebooks/team.chat"), fx.JUPYTER_CHAT);
    await vscode.commands.executeCommand("chatLeak.rescan");
    await expectWait(M("secret removed again"), () => api.getFindings().length === T, 15000, () => dump(api.getFindings()));

    // Settings: in an untrusted workspace the repository's own settings are ignored.
    await conf().update("rules", { CL003: "off" }, vscode.ConfigurationTarget.Workspace);
    await sleep(1500);
    await vscode.commands.executeCommand("chatLeak.rescan");
    if (trusted) await expectWait(M("workspace rules: CL003 off"), () => !api.getFindings().some((f) => f.rule === "CL003"));
    else check(M("untrusted: workspace rules setting ignored"), api.getFindings().some((f) => f.rule === "CL003") && api.getFindings().length === T, dump(api.getFindings()));
    await conf().update("rules", undefined, vscode.ConfigurationTarget.Workspace);
    await conf().update("exclude", ["**/pkg/**"], vscode.ConfigurationTarget.Workspace);
    await sleep(1500);
    await vscode.commands.executeCommand("chatLeak.rescan");
    if (trusted) await expectWait(M("workspace exclude drops pkg/"), () => !api.getFindings().some((f) => f.rel.startsWith("pkg/")));
    else check(M("untrusted: workspace exclude ignored"), api.getFindings().some((f) => f.rel.startsWith("pkg/")));
    await conf().update("exclude", undefined, vscode.ConfigurationTarget.Workspace);
    await conf().update("rules", { CL002: "hint" }, vscode.ConfigurationTarget.Global);
    await expectWait(M("user rules setting applies live"), () => api.getFindings().filter((f) => f.rule === "CL002").every((f) => f.severity === "hint") && api.getFindings().length === T, 15000, () => dump(api.getFindings()));
    await conf().update("rules", undefined, vscode.ConfigurationTarget.Global);
    await conf().update("enabled", false, vscode.ConfigurationTarget.Global);
    await expectWait(M("enabled=false empties view, badge, diagnostics"), async () => api.getBadge() === 0 && (await api.getTreeItems()).length === 0 && vscode.languages.getDiagnostics().every(([, ds]) => !ds.some((d) => d.source === "ChatLeak")));
    await conf().update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await expectWait(M("re-enabled restores the findings"), () => api.getBadge() === T, 15000, () => dump(api.getFindings()));

    if (trusted) {
      // Git history scan (on demand).
      const hs = await vscode.commands.executeCommand("chatLeak.scanHistory");
      check(M("scanHistory scanned the repository"), hs && hs.scanned === 1 && hs.hits === 1, JSON.stringify(hs));
      const H = api.getFindings().filter((f) => f.rule === "CL006");
      check(M("CL006 for the deleted Aider log"), H.length === 1 && H[0].label === "old/.aider.llm.history is in past commits (added in 1 commit)" && H[0].severity === "information", dump(H));
      T += 1;
      const hG = (await api.getTreeItems()).find((t) => t.label === ".aider.llm.history");
      const hRow = hG && (await api.getTreeItems(hG.node))[0];
      check(M("history row: history action, help command"), hRow && hRow.contextValue === "finding.history" && hRow.command.command === "chatLeak.showHistoryHelp" && /past commits/.test(hG.description));
      check(M("showHistoryHelp works for a live history row"), (await vscode.commands.executeCommand("chatLeak.showHistoryHelp", ...hRow.command.arguments)) === true);
      check(M("openFinding refuses a history row"), (await vscode.commands.executeCommand("chatLeak.openFinding", ...hRow.command.arguments)) === false);

      // Screenshot of the panel.
      // The editor shows a file without (fake) keys, so the screenshot never shows token-shaped text.
      const ldoc = await vscode.workspace.openTextDocument(P("CLAUDE.local.md"));
      await vscode.window.showTextDocument(ldoc, { preview: false });
      await vscode.commands.executeCommand("workbench.view.extension.chatleak");
      for (const cmd of ["workbench.action.closeAuxiliaryBar", "notifications.clearAll", "workbench.action.closePanel"]) {
        try {
          await vscode.commands.executeCommand(cmd);
        } catch (_) {
          /* not available in this version */
        }
      }
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      for (let i = 0; i < 14; i++) {
        try {
          await vscode.commands.executeCommand("workbench.action.decreaseViewWidth");
        } catch (_) {
          break;
        }
      }
      await sleep(6000);
      fs.writeFileSync(path.join(markerDir, "shot-" + mode), "1");
      await expectWait(M("screenshot taken"), () => fs.existsSync(path.join(markerDir, "shot-done-" + mode)), 40000);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");

      // Untrack: declined, then confirmed.
      const cRow = (await api.getTreeItems((await api.getTreeItems()).find((t) => t.label === ".aider.chat.history.md").node))[0];
      api.__setConfirm(() => false);
      check(M("untrack declined does nothing"), (await vscode.commands.executeCommand("chatLeak.untrack", cRow.node)) === false);
      let ls = await core.gitLsFiles("git", root);
      check(M("still tracked after decline"), ls.files.includes(".aider.chat.history.md"));
      let asked = null;
      api.__setConfirm((rel, isDir) => {
        asked = [rel, isDir];
        return true;
      });
      check(M("untrack confirmed"), (await vscode.commands.executeCommand("chatLeak.untrack", cRow.node)) === true);
      check(M("confirmation named the file"), asked && asked[0] === ".aider.chat.history.md" && asked[1] === false);
      ls = await core.gitLsFiles("git", root);
      check(M("git rm --cached removed it from the index"), !ls.files.includes(".aider.chat.history.md"));
      check(M("file kept on disk"), fs.existsSync(P(".aider.chat.history.md")));
      await expectWait(M("CL001 replaced by CL002 and CL006"), () => {
        const G = api.getFindings().filter((f) => f.rel === ".aider.chat.history.md");
        return !G.some((f) => f.rule === "CL001") && G.some((f) => f.rule === "CL002") && G.some((f) => f.rule === "CL006" && /added in 1 commit/.test(f.label));
      }, 15000, () => dump(api.getFindings().filter((f) => f.rel === ".aider.chat.history.md")));
      // Folder untrack (SpecStory history).
      const spG = (await api.getTreeItems()).find((t) => t.label === "history" && t.description.startsWith(".specstory"));
      const spRow = spG && (await api.getTreeItems(spG.node)).find((r) => r.contextValue.includes("untrackable"));
      check(M("SpecStory folder untrack"), spRow && (await vscode.commands.executeCommand("chatLeak.untrack", spRow.node)) === true && asked[1] === true);
      ls = await core.gitLsFiles("git", root);
      check(M("SpecStory folder no longer tracked"), !ls.files.some((f) => f.startsWith(".specstory/")));
      check(M("stale untrack node refused"), (await vscode.commands.executeCommand("chatLeak.untrack", cRow.node)) === false);
      api.__setConfirm(null);
      check(M("hostile fsmonitor / hooks never ran"), !fs.existsSync(marker));
    } else {
      check(M("untrusted: scanHistory refused"), (await vscode.commands.executeCommand("chatLeak.scanHistory")).scanned === 0);
      api.__setConfirm(() => true);
      check(M("untrusted: untrack refused"), (await vscode.commands.executeCommand("chatLeak.untrack", (await api.getTreeItems((await api.getTreeItems())[0].node))[0].node)) === false);
      api.__setConfirm(null);
      check(M("untrusted: git never ran (no fsmonitor marker)"), !fs.existsSync(marker));
      check(M("untrusted: stats report no git"), api.getStats().gitFolders === 0);
    }

    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["chatLeak.rescan", "chatLeak.scanHistory", "chatLeak.addToIgnore", "chatLeak.untrack", "chatLeak.showHistoryHelp", "chatLeak.openFinding", "chatLeak.focusView", "chatLeak.openSettings"]) check(M(`command ${c} registered`), cmds.includes(c));
  } catch (e) {
    check(M("unexpected exception"), false, String(e && e.stack ? e.stack : e));
  }

  await vscode.commands.executeCommand("workbench.action.files.saveAll");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  fs.writeFileSync(resultFile, JSON.stringify({ passed, failed, results }, null, 2));
  if (failed) throw new Error(`${failed} in-editor checks failed`);
}

module.exports = { run };
