import { stat } from "fs/promises";
import { basename } from "path";
import { commands, ExtensionContext, ProgressLocation, Uri, window } from "vscode";
import { copyWithSuffix, deleteVerifiedSources, type CopyPlan, type FileProgress } from "./backup";
import { getSettings } from "./config";
import { scriptPathFor, stripBakSuffix, type StripResult } from "./stripBak";
import { renameForTransform } from "./transform";

const BACKUP_COMMAND = "fileBackup.backup";
const STRIP_COMMAND = "fileBackup.stripBak";
const ROUND_TRIP_COMMAND = "fileBackup.cRoundTrip";

const DELETE_DELAY_MS = 2000;

interface ActionResult {
  count: number;
  note: string;
}

const EMPTY_STRIP: StripResult = {
  restored: [], conflicts: [], numbered: [], undeleted: [], failed: [], unreadableDirs: [],
};

export function activate(context: ExtensionContext): void {
  const script = scriptPathFor(context.extensionPath);

  context.subscriptions.push(
    commands.registerCommand(BACKUP_COMMAND, (t, s) => runOver("生成", "个备份", t, s, backupOne)),
    commands.registerCommand(STRIP_COMMAND, (t, s) =>
      runOver("还原", "个文件", t, s, (src, onFile) => stripOne(script, src, onFile))
    ),
    commands.registerCommand(ROUND_TRIP_COMMAND, (t, s) =>
      runOver("往返完成", "个文件", t, s, (src, onFile) => roundTrip(script, src, onFile))
    )
  );
}

export function deactivate(): void {
  // No cleanup needed
}

async function backupOne(source: string, onFile: FileProgress): Promise<ActionResult> {
  const isDir = (await stat(source)).isDirectory();
  const plan = await copyWithSuffix(source, ".bak", onFile);
  const copies = plan.pairs.length;
  const note = isDir
    ? `${basename(source)}/ → 备份 ${copies} 份${parens(describePlan(plan))}`
    : `${basename(source)} → ${basename(plan.pairs[0]?.target ?? "")}${parens(describePlan(plan))}`;

  return { count: isDir ? copies + 1 : copies, note };
}

async function stripOne(script: string, source: string, onFile: FileProgress): Promise<ActionResult> {
  const isDir = (await stat(source)).isDirectory();
  const result = await stripBakSuffix(script, source);

  return {
    count: result.restored.length,
    note: `${basename(source)}${isDir ? "/" : ""} → 还原 ${result.restored.length} 个${parens(describeStrip(result, "其中"))}`,
  };
}

/**
 * Six phases, in order and none of them optional:
 * 1. rename in place — protected extensions gain `.c1`, everything else `.c`;
 * 2. wait 2 seconds;
 * 3. copy everything into `.bak` backups (a folder becomes `<dir>.bak/`);
 * 4. delete the renamed sources (single-file case only), after byte comparison;
 * 5. PowerShell strips the suffixes inside the backups;
 * 6. PowerShell strips them in the source folder too, in reverse rename order.
 *
 * Every phase isolates per-file failures: one locked file can no longer cost the
 * rest of the tree, and skipped/unreadable directories are named in the report.
 */
async function roundTrip(script: string, source: string, onFile: FileProgress): Promise<ActionResult> {
  const cfg = getSettings();
  const isDir = (await stat(source)).isDirectory();
  const suffixList = [cfg.backupSuffix, cfg.normalSuffix, cfg.protectedSuffix];

  const renamed = await renameForTransform(source, cfg, onFile);
  if (renamed.pairs.length === 0) {
    if (!isDir) {
      return { count: 0, note: `${basename(source)} 本身就是备份文件，未做改动` };
    }
    throw new Error("没有可改名的文件");
  }

  await sleep(DELETE_DELAY_MS);

  const plan = await copyWithSuffix(isDir ? source : renamed.pairs[0].after, cfg.backupSuffix, onFile);
  const keptSources = isDir ? [] : await deleteVerifiedSources(plan.pairs, onFile);
  const stripped = await stripBakSuffix(script, scopeOf(plan), suffixList);
  const restoredSources = isDir
    ? await stripBakSuffix(script, source, suffixList, renamed.pairs.map((r) => r.after).reverse())
    : EMPTY_STRIP;

  const problems = [
    ...new Set([
      ...describeRenamed(renamed.failed, renamed.skippedDirs, renamed.unreadableDirs),
      ...describePlan(plan),
      keptSources.length ? `${keptSources.length} 个源文件校验不符而未删` : "",
      ...describeStrip(stripped, "备份"),
      isDir ? describeStrip(restoredSources, "源里") : [],
    ].filter(Boolean)),
  ];

  return {
    count: stripped.restored.length,
    note:
      `${basename(source)}${isDir ? "/" : ""} → 改名 ${renamed.pairs.length} 个，` +
      `等 ${DELETE_DELAY_MS / 1000}s，生成 ${cfg.backupSuffix} ${plan.pairs.length} 份，` +
      (isDir
        ? `源复原 ${restoredSources.restored.length} 个，`
        : `删源 ${plan.pairs.length - keptSources.length} 个，`) +
      `备份复原 ${stripped.restored.length} 个${problems.length ? `（${problems.join("；")}）` : ""}`,
  };
}

function scopeOf(plan: CopyPlan): string {
  const scope = plan.snapshot ?? plan.pairs[0]?.target;
  if (!scope) {
    throw new Error("没有生成任何备份副本");
  }
  return scope;
}

function describeRenamed(
  failed: { file: string; reason: string }[],
  skippedDirs: string[],
  unreadableDirs: string[]
): string[] {
  return [
    failed.length ? `改名失败 ${failed.length} 个：${list(failed.map((f) => `${f.file} (${f.reason})`))}` : "",
    skippedDirs.length ? `跳过备份目录 ${skippedDirs.length} 个：${list(skippedDirs)}` : "",
    unreadableDirs.length ? `读不了的目录 ${unreadableDirs.length} 个：${list(unreadableDirs)}` : "",
  ];
}

function describePlan(plan: CopyPlan): string[] {
  return [
    plan.failed.length ? `备份失败 ${plan.failed.length} 个：${list(plan.failed.map((f) => `${f.file} (${f.reason})`))}` : "",
    plan.skippedDirs.length ? `跳过备份目录 ${plan.skippedDirs.length} 个：${list(plan.skippedDirs)}` : "",
    plan.unreadableDirs.length ? `读不了的目录 ${plan.unreadableDirs.length} 个：${list(plan.unreadableDirs)}` : "",
  ];
}

function describeStrip(result: StripResult, where: string): string[] {
  return [
    result.conflicts.length ? `${where} ${result.conflicts.length} 个同名冲突跳过` : "",
    result.numbered.length ? `${where} ${result.numbered.length} 个编号副本未处理` : "",
    result.undeleted.length ? `${where} ${result.undeleted.length} 个副本未能删除` : "",
    result.failed.length ? `${where} ${list(result.failed)} 校验失败已回滚` : "",
    result.unreadableDirs.length
      ? `${where} ${result.unreadableDirs.length} 个目录/路径读不了：${list(result.unreadableDirs)}`
      : "",
  ];
}

function list(items: string[], max = 3): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} 等 ${items.length} 项`;
}

function parens(clauses: string[]): string {
  const kept = [...new Set(clauses.filter(Boolean))];
  return kept.length ? `（${kept.join("；")}）` : "";
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
  action: (source: string, onFile: FileProgress) => Promise<ActionResult>
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
        const onFile: FileProgress = (done, name) =>
          progress.report({ message: `${done} 个已完成 · ${name}` });

        progress.report({ message: `${i + 1}/${uris.length} ${basename(source)}`, increment: 100 / uris.length });

        try {
          const result = await action(source, onFile);
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
    await window.showWarningMessage(`${summary}: ${list(failed)}`);
  } else {
    await window.showInformationMessage(`${summary}: ${list(lines)}`);
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
