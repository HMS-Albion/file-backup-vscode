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

/** Whole-tree backup of a directory: `<dir>.bak/` holding only `<file>.bak` copies. */
export async function backupDirectory(dirPath: string, suffix = BAK): Promise<string[]> {
  const plan = await copyWithSuffix(dirPath, suffix);
  return [plan.snapshot as string, ...plan.pairs.map((p) => p.target)];
}

/**
 * Produces `<name><suffix>` copies of everything under srcPath.
 *
 * A file yields one pair. A directory yields a snapshot directory whose tree is
 * mirrored, with every file stored as `<name><suffix>` inside it — source files
 * are never copied into the snapshot, and the source tree is never modified.
 * Entries that already look like `.bak` backups are skipped.
 */
export async function copyWithSuffix(srcPath: string, suffix = BAK): Promise<CopyPlan> {
  const info = await stat(srcPath);

  if (info.isFile()) {
    return { pairs: [{ source: srcPath, target: await createBackup(srcPath, undefined, suffix) }] };
  }

  const snapshot = await nextFreePath(path.join(path.dirname(srcPath), path.basename(srcPath) + suffix));
  const plan: CopyPlan = { snapshot, pairs: [] };
  await mirrorInto(srcPath, snapshot, plan, suffix);
  return plan;
}

/**
 * Deletes each pair's source file, but only after confirming the copy is
 * byte-identical. Returns the sources that were kept, so a caller can report
 * exactly what was not removed.
 */
export async function deleteVerifiedSources(pairs: CopyPair[]): Promise<string[]> {
  const kept: string[] = [];

  for (const { source, target } of pairs) {
    if (!(await identical(source, target))) {
      kept.push(source);
      continue;
    }

    try {
      await unlink(source);
    } catch {
      kept.push(source);
    }
  }

  return kept;
}

async function mirrorInto(srcDir: string, destDir: string, plan: CopyPlan, suffix: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (isBackupName(entry.name, suffix)) {
      continue;
    }

    const srcFile = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      await mirrorInto(srcFile, path.join(destDir, entry.name), plan, suffix);
    } else if (entry.isFile()) {
      const target = await createBackup(srcFile, destDir, suffix);
      plan.pairs.push({ source: srcFile, target });
    }
  }
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
