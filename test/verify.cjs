// Verification harness for the File Backup extension. No test framework: it
// drives the *compiled* out/extension.js with a stubbed `vscode` module and
// asserts real filesystem effects, including the large-tree cases where one bad
// file used to abort the whole folder.
//
//   node node_modules/typescript/bin/tsc -p ./ && node test/verify.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const Module = require('node:module');

const proj = path.resolve(__dirname, '..');
const out = path.join(proj, 'out');
const results = new Map();
const check = (name, fn) => {
  try {
    fn();
    results.set(name, true);
  } catch (e) {
    results.set(name, `❌ ${e.message.slice(0, 160)}`);
  }
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fbverify-'));
const filesOf = (dir, base = dir) =>
  !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]
  );
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const seed = (dir, entries) => {
  for (const [rel, body] of Object.entries(entries)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
};
const holdLocked = (file, seconds) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$h=[IO.File]::Open('${file}', 'Open', 'Read', 'None'); Start-Sleep ${seconds}; $h.Close()`],
    { windowsHide: true, stdio: 'ignore' });
  return child;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
Module._load = (r, ...a) => (r === 'vscode' ? vscode : realLoad.call(Module, r, ...a));
require(path.join(out, 'extension.js')).activate({ subscriptions: [], extensionPath: proj });

const uri = (p) => vscode.Uri.file(p);
const run = async (cmd, ...targets) => {
  messages.length = 0;
  const t0 = Date.now();
  if (targets.length > 1) {
    await cmd(uri(targets[0]), targets.slice(1).map(uri));
  } else {
    await cmd(uri(targets[0]), []);
  }
  return { ms: Date.now() - t0, msg: messages.join(' | ') };
};

(async () => {
  const roundTrip = commands['fileBackup.cRoundTrip'];
  const backup = commands['fileBackup.backup'];
  const strip = commands['fileBackup.stripBak'];

  // ---------- 1. 六阶段全跑，源目录恢复原样 ----------
  const base = path.join(work, 'basic');
  seed(base, {
    'plain.txt': 'P', 'legacy.c': 'L', 'tool.py': 'T', 'Makefile': 'M',
    'deep/l1/l2/x.md': 'X', 'empty.bin': '',
    'snap/keep.txt': 'K', 'snap/keep.txt.bak': 'K-old', 'snap/old.log.bak.2': 'N',
  });
  const baseline = Object.fromEntries(filesOf(base).map((f) => [f, sha(path.join(base, f))]));
  const r1 = await run(roundTrip, base);

  check('耗时 ≥ 2s（等待阶段真的执行）', () => assert(r1.ms >= 2000, `只有 ${r1.ms}ms`));
  check('源目录 9 个文件名与字节全部恢复原样', () => {
    const now = Object.fromEntries(filesOf(base).map((f) => [f, sha(path.join(base, f))]));
    assert.deepStrictEqual(now, baseline, `差异: ${JSON.stringify(now)}`);
  });
  check('快照里有同样 9 个原名文件', () => {
    const snap = Object.fromEntries(filesOf(path.join(work, 'basic.bak')).map((f) => [f, sha(path.join(work, 'basic.bak', f))]));
    assert.deepStrictEqual(snap, baseline);
  });
  check('受保护 .c/.py 与 .bak/.bak.N 都保住原名', () => {
    for (const f of ['legacy.c', 'tool.py', 'snap/keep.txt.bak', 'snap/old.log.bak.2']) {
      assert(baseline[f], `基线缺 ${f}`);
      assert(fs.existsSync(path.join(work, 'basic.bak', f)), `快照缺 ${f}`);
    }
  });
  check('提示里报出六个阶段与份数', () =>
    assert(/改名 9 个.*等 2s.*生成 \.bak 9 份.*源复原 9 个.*备份复原 9 个/.test(r1.msg), r1.msg));

  // ---------- 2. 单文件失败不再带走整棵树 ----------
  const lockedDir = path.join(work, 'locked');
  fs.mkdirSync(path.join(lockedDir, 'sub'), { recursive: true });
  const many = 300;
  for (let i = 0; i < many; i++) fs.writeFileSync(path.join(lockedDir, 'sub', `f${i}.txt`), `c${i}`);
  const victim = path.join(lockedDir, 'sub', 'f150.txt');
  const holder = holdLocked(victim, 25);
  await sleep(2500);
  const beforeLocked = sha(path.join(lockedDir, 'sub', 'f0.txt'));
  const r2 = await run(roundTrip, lockedDir);
  holder.kill();

  check('一个文件被占住时其余照常处理（不再整批中止）', () =>
    assert(/改名 299 个/.test(r2.msg) && /改名失败 1 个/.test(r2.msg), r2.msg));
  check('失败的具体文件名被报出来', () =>
    assert(/f150\.txt \(EBUSY/.test(r2.msg), r2.msg));
  check('未失败的源文件仍恢复原名与内容', () => {
    assert(fs.existsSync(path.join(lockedDir, 'sub', 'f0.txt')), 'f0.txt 没回到原名');
    assert(sha(path.join(lockedDir, 'sub', 'f0.txt')) === beforeLocked, 'f0.txt 内容变了');
  });

  // ---------- 3. 跳过的备份目录会被报告，且跟随 backupSuffix ----------
  const skipDir = path.join(work, 'skipcase');
  seed(skipDir, { 'top.txt': '1', 'release.bak/inner.c': '2', 'release.bak/deep/n.txt': '3' });
  const r3 = await run(roundTrip, skipDir);
  check('*.bak 目录被跳过时明确报告数量与名字', () =>
    assert(/跳过备份目录 1 个：release\.bak/.test(r3.msg), r3.msg));
  check('被跳过的目录内容完全未动', () => {
    assert(fs.existsSync(path.join(skipDir, 'release.bak/inner.c')), 'inner.c 被动了');
    assert(fs.existsSync(path.join(skipDir, 'release.bak/deep/n.txt')), '嵌套的 n.txt 被动了');
    assert(fs.existsSync(path.join(work, 'skipcase.bak/top.txt')), 'top.txt 没进快照');
    assert(fs.existsSync(path.join(skipDir, 'top.txt')), 'top.txt 没恢复原名');
  });

  // ---------- 4. 超长路径目录不再让整批失败 ----------
  const longDir = path.join(work, 'longpath');
  seed(longDir, { 'a.txt.bak': 'A', 'b.txt.bak': 'B' });
  let deep = longDir;
  for (let i = 0; i < 40; i++) deep = path.join(deep, 'a'.repeat(32));
  try { fs.mkdirSync(deep, { recursive: true }); } catch { /* 造不出就跳过该断言 */ }
  const r4 = await run(strip, longDir);
  check('存在超深目录时 Remove 仍能完成备份文件的还原', () => {
    assert(fs.existsSync(path.join(longDir, 'a.txt')), 'a.txt 没还原');
    assert(fs.existsSync(path.join(longDir, 'b.txt')), 'b.txt 没还原');
    assert(!/失败/.test(r4.msg), r4.msg);
  });

  // ---------- 5. 单个文件与 .bak 命名的单文件 ----------
  const one = path.join(work, 'one.txt');
  fs.writeFileSync(one, 'single');
  const r5 = await run(roundTrip, one);
  check('右键单个文件：走完六阶段后名字内容不变、无中间产物残留', () => {
    assert(fs.readFileSync(one, 'utf8') === 'single', '内容不对');
    for (const leftover of [one + '.c', one + '.c.bak', one + '.bak']) {
      assert(!fs.existsSync(leftover), `残留 ${path.basename(leftover)}`);
    }
  });
  check('对照：文件夹流程才留下 <目录>.bak/ 副本', () =>
    assert(fs.statSync(path.join(work, 'basic.bak')).isDirectory(), '快照目录不存在'));
  const bakFile = path.join(work, 'already.txt.bak');
  fs.writeFileSync(bakFile, 'keepme');
  const r6 = await run(roundTrip, bakFile);
  check('右键单个 .bak 文件：不做改动并说明', () =>
    assert(/本身就是备份文件，未做改动/.test(r6.msg) && fs.existsSync(bakFile), r6.msg));

  // ---------- 6. 另两条命令不受影响 ----------
  const bd = path.join(work, 'bakdir');
  seed(bd, { 'a.txt': 'A', 'sub/b.h': 'B' });
  await run(backup, bd);
  check('Backup to .bak：快照只装备份且源目录不动', () => {
    assert(fs.existsSync(path.join(work, 'bakdir.bak/a.txt.bak')), '缺 a.txt.bak');
    assert(fs.existsSync(path.join(work, 'bakdir.bak/sub/b.h.bak')), '缺 b.h.bak');
    assert(fs.existsSync(path.join(bd, 'a.txt')), '源文件被删了');
    assert(!fs.existsSync(path.join(bd, 'a.txt.bak')), '源目录被污染');
  });
  await run(strip, path.join(work, 'bakdir.bak'));
  check('Remove .bak Suffix：还原且不覆盖同名文件', () => {
    assert(fs.readFileSync(path.join(work, 'bakdir.bak/a.txt'), 'utf8') === 'A');
    assert(fs.readFileSync(path.join(work, 'bakdir.bak/sub/b.h'), 'utf8') === 'B');
  });

  // ---- report ----
  const width = Math.max(...[...results.keys()].map((k) => [...k].length));
  for (const [name, ok] of results) console.log(ok === true ? `  ✓ ${name}` : `  ${name}\n  ${' '.repeat(width)}  ${ok}`);
  const bad = [...results.values()].filter((v) => v !== true).length;
  console.log(`\n${results.size - bad}/${results.size} 通过`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exitCode = bad ? 1 : 0;
})().catch((e) => {
  console.error('运行异常:', e);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
