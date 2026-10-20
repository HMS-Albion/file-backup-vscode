import { readdir, stat } from "fs/promises";
import * as path from "path";
import type { Settings } from "./config";
import { isBackupName, nextFreePath, type FileProgress } from "./backup";
import { runShellScript } from "./shell";

export interface RenamePair {
  before: string;
  after: string;
}

export interface RenameOutcome {
  pairs: RenamePair[];
  /** Files the shell refused to rename (locked, permissions, path too long). */
  failed: { file: string; reason: string }[];
  /** Backup-named directories left alone, relative to the root. */
  skippedDirs: string[];
  /** Directories that could not be listed at all. */
  unreadableDirs: string[];
}

/** What scripts/rename-files.ps1 answers with. */
interface RenameScriptResult {
  renamed: { from: string; to: string }[];
  failed: { file: string; reason: string }[];
}

/**
 * The shell script reports stable codes instead of Chinese text, because
 * PowerShell 5.1 would decode non-ASCII literals in the script as mojibake.
 * The readable wording is added here, where it survives the pipe.
 */
const REASON_TEXT: Record<string, string> = {
  "source-missing": "源文件不存在",
  "target-taken": "目标名称已被占用",
  "malformed-instruction": "重命名指令格式错误",
  "move-failed": "重命名失败",
};

function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

/**
 * The suffix a file gets: protected extensions (`.c`, `.h`, `.py` by default)
 * keep their own extension and only gain the appended suffix, everything else
 * gets the general suffix.
 *
 * `includeBackups` decides whether names that already look like backups
 * (`.bak`, `.bak.1`) take part. Right-clicking a folder says yes so those files
 * are carried along; right-clicking a single such file says no and leaves it.
 */
export function suffixFor(name: string, cfg: Settings, includeBackups: boolean): string | undefined {
  if (!includeBackups && isBackupName(name, cfg.backupSuffix)) {
    return undefined;
  }

  const ext = path.extname(name).toLowerCase();
  return cfg.protectedExtensions.includes(ext) ? cfg.protectedSuffix : cfg.normalSuffix;
}

/**
 * Works out the new name of every file under root that takes part in the
 * transform round trip.
 *
 * Nothing is moved here — the plan is only computed. The actual rename is done
 * by the shell script, so one locked file cannot abort the rest of the tree.
 *
 * A single file is only renamed when it is not itself a backup; a directory
 * renames everything inside it, backups included, so nothing is left behind.
 * Directories named like backups (previous snapshots) are skipped, but the skip
 * is reported instead of being silent — and the check follows the configured
 * backupSuffix rather than a hardcoded `.bak`.
 */
export async function planRenames(
  root: string,
  cfg: Settings,
  onProgress?: FileProgress
): Promise<RenameOutcome> {
  const result: RenameOutcome = { pairs: [], failed: [], skippedDirs: [], unreadableDirs: [] };
  const info = await stat(root);

  if (info.isFile()) {
    const suffix = suffixFor(path.basename(root), cfg, false);
    if (suffix) {
      const after = await nextFreePath(root + suffix);
      result.pairs.push({ before: root, after });
    }
    return result;
  }

  const { dirs, skippedDirs, unreadableDirs } = await listDirs(root, cfg.backupSuffix);
  result.skippedDirs = skippedDirs;
  result.unreadableDirs = unreadableDirs;

  const pending: { file: string; suffix: string }[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir.path, { withFileTypes: true });
    } catch (err) {
      result.unreadableDirs.push(`${relativeOf(root, dir.path)} (${reason(err)})`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const suffix = suffixFor(entry.name, cfg, true);
      if (suffix) {
        pending.push({ file: path.join(dir.path, entry.name), suffix });
      }
    }
  }

  // Protected files first: `main.c` moves to `main.c.c1`, which frees the `main.c`
  // name that `main.txt` is about to take, so far fewer collisions need numbering.
  const ordered = [
    ...pending.filter((p) => p.suffix === cfg.protectedSuffix),
    ...pending.filter((p) => p.suffix !== cfg.protectedSuffix),
  ];

  // The target name is only reserved now, the rename itself happens in one
  // shell call below. Numbering therefore reflects the order the shell will
  // apply, and two files that want the same name still get distinct targets.
  for (const item of ordered) {
    const after = await nextFreePath(item.file + item.suffix);
    result.pairs.push({ before: item.file, after });
  }

  return result;
}

/**
 * Renames the planned files by handing the whole list to the shell script.
 *
 * The script moves each file and reports what it could not move. The plan is
 * the source of truth for the new names; the script only confirms which of them
 * actually happened, so a failure is attributed to the right file.
 */
export async function applyRenames(
  scriptPath: string,
  root: string,
  pairs: RenamePair[],
  onProgress?: FileProgress
): Promise<RenameOutcome> {
  const result: RenameOutcome = { pairs: [], failed: [], skippedDirs: [], unreadableDirs: [] };
  if (pairs.length === 0) {
    return result;
  }

  const env = { FB_RENAMES: pairs.map((p) => `${p.before}\t${p.after}`).join("\n") };
  const output = await runShellScript<RenameScriptResult>(scriptPath, env);

  const moved = new Set((output.renamed ?? []).map((r) => r.from));
  for (const pair of pairs) {
    if (moved.has(pair.before)) {
      result.pairs.push(pair);
    }
  }

  // The script names the files it refused; anything it did not report at all
  // and did not move is a failure too, so nothing is silently dropped.
  for (const pair of pairs) {
    if (moved.has(pair.before)) {
      continue;
    }
    const reportedFailure = (output.failed ?? []).find((f) => f.file === pair.before);
    result.failed.push({
      file: relativeOf(root, pair.before),
      reason: reportedFailure ? reasonText(reportedFailure.reason) : "重命名未完成",
    });
  }

  onProgress?.(result.pairs.length + result.failed.length, "");

  return result;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err);
}

function relativeOf(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || path.basename(target);
}

interface WalkedDir {
  path: string;
}

/** Every directory in the tree, never descending into backup-named ones. */
async function listDirs(
  dir: string,
  backupSuffix: string
): Promise<{ dirs: WalkedDir[]; skippedDirs: string[]; unreadableDirs: string[] }> {
  const dirs: WalkedDir[] = [{ path: dir }];
  const skippedDirs: string[] = [];
  const unreadableDirs: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      unreadableDirs.push(`${relativeOf(dir, current)} (${reason(err)})`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const child = path.join(current, entry.name);
      if (isBackupName(entry.name, backupSuffix)) {
        skippedDirs.push(relativeOf(dir, child));
        continue;
      }

      dirs.push({ path: child });
      await walk(child);
    }
  };

  await walk(dir);
  return { dirs, skippedDirs, unreadableDirs };
}
