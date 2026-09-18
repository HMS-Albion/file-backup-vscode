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
