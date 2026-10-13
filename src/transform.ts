import { readdir, rename, stat } from "fs/promises";
import * as path from "path";
import type { Settings } from "./config";
import { isBackupName, nextFreePath, type FileProgress } from "./backup";

export interface RenamePair {
  before: string;
  after: string;
}

export interface RenameOutcome {
  pairs: RenamePair[];
  /** Files rename() refused (locked, permissions, path too long). */
  failed: { file: string; reason: string }[];
  /** Backup-named directories left alone, relative to the root. */
  skippedDirs: string[];
  /** Directories that could not be listed at all. */
  unreadableDirs: string[];
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
 * Renames files for the transform round trip.
 *
 * A single file is only renamed when it is not itself a backup; a directory
 * renames everything inside it, backups included, so nothing is left behind.
 * Directories named like backups (previous snapshots) are skipped, but the skip
 * is reported instead of being silent — and the check follows the configured
 * backupSuffix rather than a hardcoded `.bak`.
 *
 * A file that cannot be renamed is collected into `failed` and the rest of the
 * tree keeps going; one locked file must not cost 400 processed files.
 */
export async function renameForTransform(
  root: string,
  cfg: Settings,
  onProgress?: FileProgress
): Promise<RenameOutcome> {
  const result: RenameOutcome = { pairs: [], failed: [], skippedDirs: [], unreadableDirs: [] };
  const info = await stat(root);

  if (info.isFile()) {
    const suffix = suffixFor(path.basename(root), cfg, false);
    if (suffix) {
      await attemptRename(root, suffix, root, result, onProgress);
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

  for (const item of ordered) {
    await attemptRename(item.file, item.suffix, root, result, onProgress);
  }

  return result;
}

async function attemptRename(
  file: string,
  suffix: string,
  root: string,
  result: RenameOutcome,
  onProgress: FileProgress | undefined
): Promise<void> {
  const name = relativeOf(root, file);

  try {
    const after = await nextFreePath(file + suffix);
    await rename(file, after);
    result.pairs.push({ before: file, after });
  } catch (err) {
    result.failed.push({ file: name, reason: reason(err) });
  }

  onProgress?.(result.pairs.length + result.failed.length, name);
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
