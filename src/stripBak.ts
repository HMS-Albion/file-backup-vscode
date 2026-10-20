import { runShellScript } from "./shell";

export interface StripResult {
  /** File names restored without the `.bak` suffix. */
  restored: string[];
  /** `.bak` files left alone because the target name already exists. */
  conflicts: string[];
  /** Numbered `name.bak.1` … left alone: which copy to restore is ambiguous. */
  numbered: string[];
  /** Restored and verified, but the `.bak` could not be deleted. */
  undeleted: string[];
  /** Copy or hash verification failed; the target was rolled back. */
  failed: string[];
  /** Directories PowerShell could not enumerate, or allow-list paths that vanished. */
  unreadableDirs: string[];
}

/** One "move this exact file to that exact name" instruction. */
export interface StripMapping {
  from: string;
  to: string;
}

/**
 * Runs scripts/strip-bak.ps1 through PowerShell, which restores every matching
 * suffixed file under targetPath by copying, verifying with SHA256, then
 * deleting the copy it consumed. Suffixes are stripped repeatedly, so
 * `notes.txt.c.bak` ends up as `notes.txt`.
 *
 * Pass `mappings` to hand over an exact rename ledger, or `only` to restrict the
 * run to an exact list of files instead of scanning `targetPath`.
 *
 * `mappings` is the precise mode: the script never guesses a target name, so a
 * user file that legitimately ends in one of our suffixes (`report.c1`) keeps
 * that suffix instead of having it stripped a second time. The round trip uses
 * it, because it already knows every rename it performed.
 *
 * Paths, suffixes and mappings travel in FB_ROOT / FB_SUFFIXES / FB_MAP / FB_ONLY
 * rather than on the command line, so names with spaces or shell metacharacters
 * cannot break the invocation.
 */
export function stripBakSuffix(
  scriptPath: string,
  targetPath: string,
  suffixes: string[] = [".bak"],
  only?: string[],
  mappings?: StripMapping[]
): Promise<StripResult> {
  const env: NodeJS.ProcessEnv = {
    FB_ROOT: targetPath,
    FB_SUFFIXES: suffixes.join(","),
  };
  if (mappings && mappings.length > 0) {
    env.FB_MAP = mappings.map((m) => `${m.from}\t${m.to}`).join("\n");
  } else if (only) {
    env.FB_ONLY = only.join("\n");
  }

  return runShellScript<StripResult>(scriptPath, env);
}
