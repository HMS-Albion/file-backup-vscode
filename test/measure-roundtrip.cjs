// Runs the File Backup cRoundTrip command over a copy of the real project tree
// and compares file/dir counts before and after. The original tree is never
// touched: this script works on a copy under a temp dir.
//
//   node test/measure-roundtrip.cjs <sourceDir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const proj = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2]);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmeasure-'));
const target = path.join(work, path.basename(src));

// ---- stubbed vscode ----
const messages = [];
const commands = {};
const vscode = {
  commands: { registerCommand: (id, h) => { commands[id] = h; return { dispose() {} }; } },
  workspace: { getConfiguration: () => ({ get: (_k, dflt) => dflt }) },
  window: {
    withProgress: async (_o, cb) => cb({ report: () => {} }, {}),
    showInformationMessage: async (m) => messages.push(m),
    showWarningMessage: async (m) => messages.push(m),
  },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (p) => ({ fsPath: p, path: '/' + p.replace(/\\/g, '/'), scheme: 'file' }) },
};
const realLoad = Module._load;
Module._load = (r, ...a) => (r === 'vscode' ? vscode : realLoad.call(Module, r, a));
require(path.join(proj, 'out/extension.js')).activate({ subscriptions: [], extensionPath: proj });

const listAll = (root) => {
  const files = [];
  const dirs = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) { dirs.push(rel); walk(p); } else { files.push(rel); }
    }
  };
  walk(root);
  return { files: files.sort(), dirs: dirs.sort() };
};

const countByExt = (files) => {
  const m = new Map();
  for (const f of files) {
    const e = path.extname(f) || '(无扩展名)';
    m.set(e, (m.get(e) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

(async () => {
  console.log(`源目录: ${src}`);
  console.log(`工作副本: ${target}`);

  // Copy with shell-free recursive copy (node 18+ has fs.cpSync).
  fs.cpSync(src, target, { recursive: true });
  console.log('复制完成。\n');

  const before = listAll(target);
  console.log('=== 执行前 ===');
  console.log(`文件 ${before.files.length}，目录 ${before.dirs.length}`);
  console.log('按扩展名:');
  for (const [e, n] of countByExt(before.files)) console.log(`  ${e}: ${n}`);

  const t0 = Date.now();
  await commands['fileBackup.cRoundTrip'](vscode.Uri.file(target), []);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const after = listAll(target);
  console.log(`\n=== 执行后（用时 ${secs}s）===\n`);
  console.log(`文件 ${after.files.length}，目录 ${after.dirs.length}`);
  console.log('按扩展名:');
  for (const [e, n] of countByExt(after.files)) console.log(`  ${e}: ${n}`);

  const bset = new Set(before.files);
  const aset = new Set(after.files);
  const added = after.files.filter((f) => !bset.has(f));
  const removed = before.files.filter((f) => !aset.has(f));

  console.log(`\n=== 差异 ===`);
  console.log(`新增 ${added.length}，消失 ${removed.length}`);
  if (removed.length) {
    console.log('\n消失的文件（前 30）:');
    for (const f of removed.slice(0, 30)) console.log('  - ' + f);
  }
  if (added.length) {
    console.log('\n新增的文件（前 30）:');
    for (const f of added.slice(0, 30)) console.log('  + ' + f);
  }
  console.log('\n报告:');
  for (const m of messages) console.log('  ' + m);
  console.log(`\n工作副本保留在: ${target}`);
})().catch((e) => {
  console.error('❌', e.stack);
  process.exitCode = 1;
});
