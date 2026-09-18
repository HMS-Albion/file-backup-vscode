import { stat } from "fs/promises";
import { basename } from "path";
import { commands, ExtensionContext, ProgressLocation, Uri, window } from "vscode";
import { backupDirectory, createBackup } from "./backup";
import { scriptPathFor, stripBakSuffix } from "./stripBak";

const BACKUP_COMMAND = "fileBackup.backup";
const STRIP_COMMAND = "fileBackup.stripBak";

interface ActionResult {
  count: number;
  note: string;
}

export function activate(context: ExtensionContext): void {
  const script = scriptPathFor(context.extensionPath);

  context.subscriptions.push(
    commands.registerCommand(BACKUP_COMMAND, (t, s) => runOver("生成", "个备份", t, s, backupOne)),
    commands.registerCommand(STRIP_COMMAND, (t, s) => runOver("还原", "个文件", t, s, (p) => stripOne(script, p)))
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

  const extras = [
    conflicts.length ? `跳过 ${conflicts.length} 个同名冲突` : "",
    numbered.length ? `${numbered.length} 个 .bak.N 未处理` : "",
    undeleted.length ? `${undeleted.length} 个 .bak 未能删除` : "",
    failed.length ? `${failed.length} 个校验失败已回滚` : "",
  ].filter(Boolean);

  return {
    count: restored.length,
    note: `${basename(source)}${isDir ? "/" : ""} → 还原 ${restored.length} 个${extras.length ? `（${extras.join("，")}）` : ""}`,
  };
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
