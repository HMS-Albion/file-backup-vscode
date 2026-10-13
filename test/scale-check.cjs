// Slow, opt-in: proves one bad file cannot cost a whole tree. Builds 2000 files
// plus a locked file and a `*.bak` directory, runs the transform, then counts the
// filesystem directly instead of trusting the reported numbers. Takes ~2 minutes.
//
//   node node_modules/typescript/bin/tsc -p ./ && node test/scale-check.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Module = require('node:module');

const proj = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fbscale-'));
const dir = path.join(work, 'big');
const sub = path.join(dir, 'sub');
const N = 2000;

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
  Uri: { file: (p) => ({ fsPath: p, path: '/' + p, scheme: 'file' }) },
};
const realLoad = Module._load;
Module._load = (r, ...a) => (r === 'vscode' ? vscode : realLoad.call(Module, r, ...a));
require(path.join(proj, 'out/extension.js')).activate({ subscriptions: [], extensionPath: proj });

(async () => {
  fs.mkdirSync(path.join(sub, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prev.bak'), { recursive: true });
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(sub, `f${i}.txt`), `content-${i}`);
  fs.writeFileSync(path.join(sub, 'nested', 'deep.md'), 'deep');
  fs.writeFileSync(path.join(dir, 'prev.bak', 'legacy.c'), '旧快照里的 .c 文件，不该被动');
  fs.writeFileSync(path.join(dir, 'prev.bak', 'x.txt.bak'), '旧快照里的备份，不该被动');

  const victim = path.join(sub, 'f999.txt');
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$h=[IO.File]::Open('${victim}', 'Open', 'Read', 'None'); Start-Sleep 60; $h.Close()`],
  { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));

  const t0 = Date.now();
  await commands['fileBackup.cRoundTrip'](vscode.Uri.file(dir), []);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  holder.kill();

  const src = fs.readdirSync(sub);
  const countFiles = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((acc, e) => acc + (e.isDirectory() ? countFiles(path.join(d, e.name)) : 1), 0);
  const snapFiles = countFiles(path.join(work, 'big.bak', 'sub'));
  const stuck = src.filter((f) => f.endsWith('.c'));
  const restored = src.filter((f) => f.endsWith('.txt'));
  const prevBak = fs.readdirSync(path.join(dir, 'prev.bak'));
  const report = messages.join(' | ');

  console.log(`用时 ${seconds}s`);
  console.log(`报告：${report.slice(0, 260)}`);
  console.log(`\n直接数文件系统：`);
  console.log(`  源目录 sub/  : 已恢复 .txt ${restored.length} 个，卡在改名态 ${stuck.length} 个 → ${stuck.join(', ') || '无'}`);
  console.log(`  快照 big.bak/sub/: ${snapFiles} 个文件`);
  console.log(`  旧快照 prev.bak/: ${prevBak.join(', ')}（应原样，且未被写进 big.bak）`);

  assert.strictEqual(restored.length, N, '恢复为原名的数量不对');
  assert.deepStrictEqual(stuck, [], '不该有文件停在改名态');
  assert.strictEqual(snapFiles, N, '快照份数不对（应含 1999 个 txt + 1 个 nested/deep.md）');
  assert(!fs.existsSync(path.join(work, 'big.bak', 'prev.bak')), '旧快照目录不该被复制进新快照');
  assert.deepStrictEqual(prevBak.sort(), ['legacy.c', 'x.txt.bak'], '旧快照目录被动了');
  assert(/改名失败 1 个：sub\/f999\.txt/.test(report), '报告没点名失败文件');
  assert(/跳过备份目录 1 个：prev\.bak/.test(report), '报告没列出被跳过的目录');
  assert((report.match(/跳过备份目录/g) || []).length === 1, '同一句被跳过目录报告应去重成一条');
  console.log('\n✅ 规模与隔离断言全部通过');
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => {
  console.error('❌', e.message);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
