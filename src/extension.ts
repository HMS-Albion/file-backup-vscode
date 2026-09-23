import { stat } from "fs/promises";
import { basename } from "path";
import { commands, ExtensionContext, ProgressLocation, Uri, window } from "vscode";
import { backupDirectory, copyWithSuffix, createBackup, deleteVerifiedSources } from "./backup";
import { getSettings } from "./config";
import { scriptPathFor, stripBakSuffix } from "./stripBak";
import { renameForTransform } from "./transform";

const BACKUP_COMMAND = "fileBackup.backup";
const STRIP_COMMAND = "fileBackup.stripBak";
const ROUND_TRIP_COMMAND = "fileBackup.cRoundTrip";

const DELETE_DELAY_MS = 2000;

interface ActionResult {
  count: number;
  note: string;
}

export function activate(context: ExtensionContext): void {
  const script = scriptPathFor(context.extensionPath);

  context.subscriptions.push(
    commands.registerCommand(BACKUP_COMMAND, (t, s) => runOver("生成", "个备份", t, s, backupOne)),
    commands.registerCommand(STRIP_COMMAND, (t, s) => runOver("还原", "个文件", t, s, (p) => stripOne(script, p))),
    commands.registerCommand(ROUND_TRIP_COMMAND, (t, s) =>
      runOver("往返完成", "个文件", t, s, (p) => roundTrip(script, p))
    )
  );
}

export function deactivate(): void {
  // No cleanup needed
}

async function backupOne(source: string): Promise<ActionResult> {
  const made = (await stat(source)).isDirectory()
    ? await backupDirectory(source)
    : [await createBackup(source)];

  const note =
    made.length === 1
      ? `${basename(source)} → ${basename(made[0])}`
      : `${basename(source)}/ → ${basename(made[0])}/ 内含 ${made.length - 1} 份`;

  return { count: made.length, note };
}

async function stripOne(script: string, source: string): Promise<ActionResult> {
  const isDir = (await stat(source)).isDirectory();
  const { restored, conflicts, numbered, undeleted, failed } = await stripBakSuffix(script, source);

  return {
    count: restored.length,
    note: `${basename(source)}${isDir ? "/" : ""} → 还原 ${restored.length} 个${suffix(restored, conflicts, numbered, undeleted, failed)}`,
  };
}

/**
 * Five phases, in order and none of them optional:
 * 1. rename in place — protected extensions (.c/.h/.py by default) gain `.c1`,
 *    every other file gains `.c`;
 * 2. wait 2 seconds;
 * 3. produce `.bak` copies with the existing backup mechanism (a folder becomes
 *    `<dir>.bak/` holding `<file>.bak` per file);
 * 4. delete the renamed sources, but only once each `.bak` copy is proven
 *    byte-identical;
 * 5. let PowerShell strip `.bak` and then `.c`/`.c1`, restoring the original
 *    names inside the backup folder.
 */
async function roundTrip(script: string, source: string): Promise<ActionResult> {
  const cfg = getSettings();
  const isDir = (await stat(source)).isDirectory();

  const renamed = await renameForTransform(source, cfg);
  if (renamed.length === 0) {
    if (!isDir) {
      return { count: 0, note: `${basename(source)} 本身就是备份文件，未做改动` };
    }
    throw new Error("没有可改名的文件");
  }

  await sleep(DELETE_DELAY_MS);

  const plan = isDir
    ? await copyWithSuffix(source, cfg.backupSuffix)
    : await copyWithSuffix(renamed[0].after, cfg.backupSuffix);

  // 文件夹转换不再删除源文件，改名后的形态留在原地；右键单个文件仍按删源处理。
  const keptSources = isDir ? [] : await deleteVerifiedSources(plan.pairs);

  const scope = plan.snapshot ?? plan.pairs[0]?.target;
  if (!scope) {
    throw new Error("没有生成任何备份副本");
  }
  const stripped = await stripBakSuffix(script, scope, [cfg.backupSuffix, cfg.normalSuffix, cfg.protectedSuffix]);

  // 文件夹流程不删源，所以改名后的文件还留在原地：只对本流程改过名的那些文件
  // 复原原名（白名单精确匹配），避免误伤 `*.bak` 目录里没被改名的文件。
  // 必须按改名的逆序撤销——正序会让先复原的文件占掉后一个的目标名。
  const suffixList = [cfg.backupSuffix, cfg.normalSuffix, cfg.protectedSuffix];
  const restoredSources = isDir
    ? await stripBakSuffix(script, source, suffixList, renamed.map((r) => r.after).reverse())
    : { restored: [], conflicts: [], numbered: [], undeleted: [], failed: [] };

  const extras = [
    keptSources.length ? `${keptSources.length} 个源文件校验不符而未删` : "",
    stripped.conflicts.length ? `${stripped.conflicts.length} 个同名冲突跳过` : "",
    stripped.numbered.length ? `${stripped.numbered.length} 个编号副本未处理` : "",
    stripped.undeleted.length ? `${stripped.undeleted.length} 个副本未能删除` : "",
    stripped.failed.length ? `${stripped.failed.length} 个校验失败已回滚` : "",
    restoredSources.conflicts.length ? `源里 ${restoredSources.conflicts.length} 个同名冲突未复原` : "",
    restoredSources.failed.length ? `源里 ${restoredSources.failed.length} 个校验失败` : "",
    restoredSources.undeleted.length ? `源里 ${restoredSources.undeleted.length} 个改名件未能删除` : "",
  ].filter(Boolean);

  return {
    count: stripped.restored.length,
    note:
      `${basename(source)}${isDir ? "/" : ""} → 改名 ${renamed.length} 个，` +
      `等 ${DELETE_DELAY_MS / 1000}s，生成 ${cfg.backupSuffix} ${plan.pairs.length} 份，` +
      (isDir
        ? `源复原 ${restoredSources.restored.length} 个，`
        : `删源 ${plan.pairs.length - keptSources.length} 个，`) +
      `备份复原 ${stripped.restored.length} 个${extras.length ? `（${extras.join("，")}）` : ""}`,
  };
}

function suffix(
  restored: string[],
  conflicts: string[],
  numbered: string[],
  undeleted: string[],
  failed: string[]
): string {
  const extras = [
    conflicts.length ? `跳过 ${conflicts.length} 个同名冲突` : "",
    numbered.length ? `${numbered.length} 个 .bak.N 未处理` : "",
    undeleted.length ? `${undeleted.length} 个 .bak 未能删除` : "",
    failed.length ? `${failed.length} 个校验失败已回滚` : "",
  ].filter(Boolean);

  return extras.length ? `（${extras.join("，")}）` : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `target` is the right-clicked item, `selected` the full multi-selection.
 * VS Code may hand an empty array, an array containing only `target`, or omit
 * it entirely, so both arguments feed one de-duplicated list.
 */
async function runOver(
  verb: string,
  unit: string,
  target: Uri | undefined,
  selected: Uri[] | undefined,
  action: (source: string) => Promise<ActionResult>
): Promise<void> {
  const uris = collect(target, selected);

  if (uris.length === 0) {
    await window.showWarningMessage("File Backup: 请先在资源管理器中选中文件或文件夹。");
    return;
  }

  const lines: string[] = [];
  const failed: string[] = [];
  let total = 0;

  await window.withProgress(
    { location: ProgressLocation.Notification, title: "File Backup", cancellable: false },
    async (progress) => {
      for (let i = 0; i < uris.length; i++) {
        const source = uris[i].fsPath;
        progress.report({
          message: `${i + 1}/${uris.length} ${basename(source)}`,
          increment: 100 / uris.length,
        });

        try {
          const result = await action(source);
          total += result.count;
          lines.push(result.note);
        } catch (err) {
          failed.push(`${basename(source)} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
  );

  const summary = `${verb} ${total} ${unit}${failed.length ? `，${failed.length} 个目标失败` : ""}`;

  if (failed.length > 0) {
    await window.showWarningMessage(`${summary}: ${truncate(failed)}`);
  } else {
    await window.showInformationMessage(`${summary}: ${truncate(lines)}`);
  }
}

function collect(target: Uri | undefined, selected: Uri[] | undefined): Uri[] {
  const seen = new Set<string>();
  const result: Uri[] = [];

  for (const uri of [...(selected ?? []), ...(target ? [target] : [])]) {
    if (uri.scheme !== "file" || seen.has(uri.fsPath)) {
      continue;
    }
    seen.add(uri.fsPath);
    result.push(uri);
  }

  return result;
}

function truncate(lines: string[], max = 4): string {
  return lines.length <= max
    ? lines.join(", ")
    : `${lines.slice(0, max).join(", ")} 等 ${lines.length} 项`;
}
