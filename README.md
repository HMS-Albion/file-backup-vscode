# File Backup (.bak)

在资源管理器里右键文件或文件夹，两个动作：

- **Backup to .bak** —— 生成 `.bak` 副本
- **Remove .bak Suffix** —— 递归去掉文件夹里所有文件的 `.bak` 后缀（从备份里恢复）

## Backup to .bak

| 源 | 结果 |
| --- | --- |
| `notes.txt` | 旁边生成 `notes.txt.bak` |
| `docs`（文件夹） | 旁边生成 `docs.bak/`：**只装备份**，镜像目录结构，每个文件存成 `<文件名>.bak`，不复制源文件、不动源目录 |
| 目标已存在 | 追加序号 `*.bak.1`、`*.bak.2`…，**永不覆盖已有备份** |

```
docs/                    ← 完全不动
  a.txt
  sub/b.txt
docs.bak/                ← 只有备份
  a.txt.bak
  sub/b.txt.bak
```

## Remove .bak Suffix

由 **`scripts/strip-bak.ps1`**（PowerShell）完成，扩展只负责起进程并解析它输出的 JSON。对每个 `.bak` 文件：

1. `Copy-Item` 原地复制出一份去掉 `.bak` 的文件；
2. `Get-FileHash -Algorithm SHA256` 比对两份，**不一致就删掉刚复制出的那份并保留 `.bak`**；
3. 一致则回写 `LastWriteTime`，再 `Remove-Item` 删除带 `.bak` 的那份；删不掉时两份都留在原地并计入提示。

待处理的根路径通过环境变量 `FB_ROOT` 传入，所有文件操作一律使用 `-LiteralPath`，因此文件名里的空格、`&`、`#`、`[`、`]` 都不会被当成通配符或命令行语法。

安全规则：

- **只处理正好以 `.bak` 结尾的文件**；`a.txt.bak.1` 这类编号备份含义不唯一，一律不动，只在提示里报数量。
- **目标名已存在就不动它**，不会用旧备份覆盖当前文件。
- **目录名不改**：`docs.bak/` 仍是 `docs.bak/`，只有里面的文件被还原。
- 也可以直接右键单个 `a.txt.bak` 文件，只还原它自己。

平台与开销：需要 `powershell.exe`（Windows PowerShell 5.1 已在用；非 Windows 需在 PATH 上的 `pwsh`，当前代码只调用 `powershell.exe`）。每选中一个目标会起一次 PowerShell 进程，实测一次调用约 0.5 秒。

提示文案形如：`还原 4 个文件: snap/ → 还原 4 个（跳过 1 个同名冲突，1 个 .bak.N 未处理，1 个 .bak 未能删除）`。

## Transform Round Trip

五个阶段按顺序全跑，一步不跳：

1. **改名**（直接 rename）：扩展名属于"受保护名单"（默认 `.c,.h,.py`）的文件保留自身扩展名、只追加 `.c1`；其他文件追加 `.c`。名字已是 `.bak` / `.bak.1` 的文件：**右键文件夹时一起改名搬走**，**右键单个这种文件时原样不动**。
2. **等待 2 秒**。
3. **生成 `.bak`**：按 Backup to .bak 的同一套规则（文件夹变成 `<目录>.bak/`，里面每个文件是 `<文件>.bak`；单个文件则是旁边的 `<文件>.bak`）。
4. **删除源文件**：**仅右键单个文件时执行**，且只删"已确认 `.bak` 副本逐字节一致"的那些；右键文件夹不删任何源文件。
5. **PowerShell 复原备份里的名字**：同一个 `strip-bak.ps1`，后缀列表由 `FB_SUFFIXES` 传入（`.bak`、`.c`、`.c1`），每个后缀最多剥一次，于是 `notes.txt.c.bak → notes.txt`、`legacy.c.c1.bak → legacy.c`。
6. **PowerShell 复原源目录里的名字**（仅文件夹）：把第 ① 步改过名的文件按**白名单**逐个还原，`main.c.c1 → main.c`、`server.js.c → server.js`。白名单由 `FB_ONLY` 传入，只含本流程改过名的那些文件，因此 `*.bak` 目录里本来就叫 `.c` 的文件不会被误剥。

### 可配置项（`Ctrl+,` 搜 File Backup）

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `fileBackup.protectedExtensions` | `.c,.h,.py` | 保留自身扩展名、只追加后缀的名单，可任意增删 |
| `fileBackup.protectedSuffix` | `.c1` | 追加给上述文件的后缀 |
| `fileBackup.normalSuffix` | `.c` | 追加给其他所有文件的后缀 |
| `fileBackup.backupSuffix` | `.bak` | 备份副本后缀，也是 Remove 命令剥掉的后缀 |

### 结果落在哪

- 右键**文件**：名字与内容不变，中间产物 `.c.bak` 全部消失，文件是重新写入的（新 inode）。
- 右键**文件夹**：转换结束后**源目录恢复原样**（文件名与字节都回到原状），同时 `<目录名>.bak/` 里是一份同名同内容的副本（连原本就叫 `.bak` / `.bak.1` 的文件也在其中并保住原名）。目录本身不改名也不删除。
- 改名顺序是"受保护文件先走"，这样 `conflict.txt.c` 会先变成 `conflict.txt.c.c1`，把 `conflict.txt.c` 这个名字腾给 `conflict.txt`，避免无谓的编号冲突。
- 若仍发生编号（目标名被占），产物叫 `<名>.c.1`；在文件夹扫描里编号文件按规则不动，需要显式右键那个文件才会复原。

## 通用细节

- 纯字节复制：不读内容、不改编码、不动源文件、时间戳保留。
- 遍历生成备份时跳过名字已是 `.bak` / `.bak.1` 的条目，不会"备份备份"；显式选中某个 `.bak` 时仍会处理它。
- 支持多选（文件与文件夹混合）；某项失败只跳过该项并在告警里列出。

## 开发

```bash
npm install
node node_modules/typescript/bin/tsc -p ./     # 产出 out/
node node_modules/@vscode/vsce/vsce package --no-dependencies
```

F5 打开扩展开发宿主窗口调试。
