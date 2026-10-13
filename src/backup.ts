import { access, cp, mkdir, open, readdir, stat, unlink } from "fs/promises";
import * as path from "path";

const BAK = ".bak";
const COMPARE_CHUNK = 64 * 1024;

/** A copied file and the original it came from. */
export interface CopyPair {
  source: string;
  target: string;
}

/** What a suffix-copy operation produced: an optional snapshot dir plus file pairs. */
export interface CopyPlan {
  snapshot?: string;
  pairs: CopyPair[];
  /** Files that could not be copied; the walk continues past them. */
  failed: { file: string; reason: string }[];
  /** Backup-named directories left alone, relative to the source root. */
  skippedDirs: string[];
  /** Directories that could not be listed. */
  unreadableDirs: string[];
}

/**
 * Copies src beside itself (or into destDir) as `<name><suffix>`.
 *
 * An existing target is never replaced: the next free `<name>.bak.1`,
 * `.bak.2`, … wins instead, so a second run cannot destroy saved bytes.
 */
export async function createBackup(srcPath: string, destDir?: string, suffix = BAK): Promise<string> {
  const target = await nextFreePath(
    path.join(destDir ?? path.dirname(srcPath), path.basename(srcPath) + suffix)
  );

  await copyFile(srcPath, target);
  return target;
}

/**
 * Produces `<name><suffix>` copies of everything under srcPath.
 *
 * A file yields one pair. A directory yields a snapshot directory whose tree is
 * mirrored, with every file stored as `<name><suffix>` inside it — source files
 * are never copied into the snapshot, and the source tree is never modified.
 * Entries that already look like `.bak` backups are skipped.
 */
export async function copyWithSuffix(srcPath: string, suffix = BAK, onProgress?: FileProgress): Promise<CopyPlan> {
  const info = await stat(srcPath);

  if (info.isFile()) {
    const plan = emptyPlan();
    await attemptCopy(srcPath, undefined, suffix, srcPath, plan, onProgress);
    return plan;
  }

  const snapshot = await nextFreePath(path.join(path.dirname(srcPath), path.basename(srcPath) + suffix));
  const plan = emptyPlan();
  plan.snapshot = snapshot;
  await mirrorInto(srcPath, snapshot, plan, suffix, srcPath, onProgress);
  return plan;
}

function emptyPlan(): CopyPlan {
  return { pairs: [], failed: [], skippedDirs: [], unreadableDirs: [] };
}

async function attemptCopy(
  srcFile: string,
  destDir: string | undefined,
  suffix: string,
  root: string,
  plan: CopyPlan,
  onProgress?: FileProgress
): Promise<void> {
  const name = relativeOf(root, srcFile);

  try {
    const target = await createBackup(srcFile, destDir, suffix);
    plan.pairs.push({ source: srcFile, target });
  } catch (err) {
    plan.failed.push({ file: name, reason: errorMessage(err) });
  }

  onProgress?.(plan.pairs.length + plan.failed.length, name);
}

/**
 * Deletes each pair's source file, but only after confirming the copy is
 * byte-identical. Returns the sources that were kept, so a caller can report
 * exactly what was not removed. A comparison that throws also keeps the file.
 */
export async function deleteVerifiedSources(
  pairs: CopyPair[],
  onProgress?: FileProgress
): Promise<string[]> {
  const kept: string[] = [];

  for (const { source, target } of pairs) {
    try {
      if (!(await identical(source, target))) {
        kept.push(source);
        continue;
      }

      await unlink(source);
    } catch {
      kept.push(source);
    }

    onProgress?.(kept.length, relativeOf(path.dirname(target), source));
  }

  return kept;
}

/** Progress callback: (done, name) for the file just finished. */
export type FileProgress = (done: number, name: string) => void;

async function mirrorInto(
  srcDir: string,
  destDir: string,
  plan: CopyPlan,
  suffix: string,
  root: string,
  onProgress?: FileProgress
): Promise<void> {
  try {
    await mkdir(destDir, { recursive: true });
  } catch (err) {
    plan.unreadableDirs.push(`${relativeOf(root, destDir)} (无法创建: ${errorMessage(err)})`);
    return;
  }

  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    plan.unreadableDirs.push(`${relativeOf(root, srcDir)} (${errorMessage(err)})`);
    return;
  }

  for (const entry of entries) {
    const srcFile = path.join(srcDir, entry.name);

    if (isBackupName(entry.name, suffix)) {
      if (entry.isDirectory()) {
        plan.skippedDirs.push(relativeOf(root, srcFile));
      }
      continue;
    }

    if (entry.isDirectory()) {
      await mirrorInto(srcFile, path.join(destDir, entry.name), plan, suffix, root, onProgress);
    } else if (entry.isFile()) {
      await attemptCopy(srcFile, destDir, suffix, root, plan, onProgress);
    }
  }
}

function relativeOf(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || path.basename(target);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err);
}

/**
 * Matches `<name><suffix>` and the numbered `<name><suffix>.1` … variants that
 * nextFreePath produces, so backups are never backed up again. `suffix` follows
 * the user's backupSuffix setting and defaults to `.bak`.
 */
export function isBackupName(name: string, suffix = BAK): boolean {
  if (name.endsWith(suffix)) {
    return true;
  }

  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }

  const tail = name.slice(dot + 1);
  return /^\d+$/.test(tail) && name.slice(0, dot).endsWith(suffix);
}

async function copyFile(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: false,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
}

/** Streams both files in chunks so comparing a large file does not load it. */
async function identical(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) {
    return false;
  }
  if (sa.size === 0) {
    return true;
  }

  const [fa, fb] = await Promise.all([open(a, "r"), open(b, "r")]);
  try {
    const bufA = Buffer.allocUnsafe(COMPARE_CHUNK);
    const bufB = Buffer.allocUnsafe(COMPARE_CHUNK);

    for (let offset = 0; offset < sa.size; offset += COMPARE_CHUNK) {
      const length = Math.min(COMPARE_CHUNK, sa.size - offset);
      const [{ bytesRead: ra }, { bytesRead: rb }] = await Promise.all([
        fa.read(bufA, 0, length, offset),
        fb.read(bufB, 0, length, offset),
      ]);

      if (ra !== rb || !bufA.subarray(0, ra).equals(bufB.subarray(0, rb))) {
        return false;
      }
    }

    return true;
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

export async function nextFreePath(candidate: string): Promise<string> {
  if (!(await exists(candidate))) {
    return candidate;
  }

  for (let i = 1; i <= 999; i++) {
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
