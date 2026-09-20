import { readdir, rename, stat } from "fs/promises";
import * as path from "path";
import type { Settings } from "./config";
import { isBackupName, nextFreePath } from "./backup";

export interface RenamePair {
  before: string;
  after: string;
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
 * Directories named like backups (previous snapshots) are never descended into.
 */
export async function renameForTransform(root: string, cfg: Settings): Promise<RenamePair[]> {
  const info = await stat(root);

  if (info.isFile()) {
    const suffix = suffixFor(path.basename(root), cfg, false);
    return suffix ? [await renameOne(root, suffix)] : [];
  }

  const pending: { file: string; suffix: string }[] = [];
  for (const dir of await listDirs(root)) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const suffix = suffixFor(entry.name, cfg, true);
      if (suffix) {
        pending.push({ file: path.join(dir, entry.name), suffix });
      }
    }
  }

  // Protected files first: `main.c` moves to `main.c.c1`, which frees the `main.c`
  // name that `main.txt` is about to take, so far fewer collisions need numbering.
  const ordered = [
    ...pending.filter((p) => p.suffix === cfg.protectedSuffix),
    ...pending.filter((p) => p.suffix !== cfg.protectedSuffix),
  ];

  const pairs: RenamePair[] = [];
  for (const item of ordered) {
    pairs.push(await renameOne(item.file, item.suffix));
  }

  return pairs;
}

async function renameOne(file: string, suffix: string): Promise<RenamePair> {
  const after = await nextFreePath(file + suffix);
  await rename(file, after);
  return { before: file, after };
}

/** Every directory in the tree, starting at root, never descending into `*.bak`. */
async function listDirs(dir: string): Promise<string[]> {
  const found = [dir];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !isBackupName(entry.name)) {
      found.push(...(await listDirs(path.join(dir, entry.name))));
    }
  }

  return found;
}
