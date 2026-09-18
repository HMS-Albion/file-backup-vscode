import { access, cp, mkdir, readdir } from "fs/promises";
import * as path from "path";

const SUFFIX = ".bak";
const MAX_SUFFIX = 999;

/**
 * Copies src beside itself as `<name>.bak`. Pass `destDir` to place the copy in
 * another directory under the same file name.
 *
 * An existing `<name>.bak` is never replaced: the next free `<name>.bak.1`,
 * `.bak.2`, … wins instead, so a second run cannot destroy what the first run
 * saved.
 *
 * @returns absolute path of the backup that was created
 */
export async function createBackup(srcPath: string, destDir?: string): Promise<string> {
  const target = await nextFreePath(
    path.join(destDir ?? path.dirname(srcPath), path.basename(srcPath) + SUFFIX)
  );

  await cp(srcPath, target, {
    recursive: false,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });

  return target;
}

/**
 * Backs up a directory as `<dir>.bak/` containing **only** backups: the
 * directory tree is mirrored and every file inside it is stored as
 * `<file>.bak`. The source files themselves are not copied, and the original
 * directory is never touched.
 *
 * @returns snapshot directory first, then each backup created inside it
 */
export async function backupDirectory(dirPath: string): Promise<string[]> {
  const snapshot = await nextFreePath(
    path.join(path.dirname(dirPath), path.basename(dirPath) + SUFFIX)
  );

  const created: string[] = [];
  await mirrorInto(dirPath, snapshot, created);

  return [snapshot, ...created];
}

/**
 * Recreates srcDir's tree under destDir, writing a `.bak` for every file.
 * Empty directories still appear in the snapshot; entries that are already
 * backups are skipped so the snapshot never holds a backup of a backup.
 */
async function mirrorInto(srcDir: string, destDir: string, created: string[]): Promise<void> {
  await mkdir(destDir, { recursive: true });

  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (isBackupName(entry.name)) {
      continue;
    }

    const srcPath = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      await mirrorInto(srcPath, path.join(destDir, entry.name), created);
    } else if (entry.isFile()) {
      created.push(await createBackup(srcPath, destDir));
    }
  }
}

/**
 * Matches both `<name>.bak` and the numbered variants `<name>.bak.1` … that
 * nextFreePath produces.
 */
export function isBackupName(name: string): boolean {
  return name.endsWith(SUFFIX) || /\.bak\.\d+$/.test(name);
}

/**
 * Returns `candidate`, or `candidate.1` … `candidate.999`, whichever does not
 * exist yet.
 */
async function nextFreePath(candidate: string): Promise<string> {
  if (!(await exists(candidate))) {
    return candidate;
  }

  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const withIndex = `${candidate}.${i}`;
    if (!(await exists(withIndex))) {
      return withIndex;
    }
  }

  throw new Error(`Too many existing backups of ${candidate}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
