import { spawn } from "child_process";
import * as path from "path";

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
}

/**
 * Runs scripts/strip-bak.ps1 through PowerShell, which restores every matching
 * suffixed file under targetPath by copying, verifying with SHA256, then
 * deleting the copy it consumed. Suffixes are stripped repeatedly, so
 * `notes.txt.c.bak` ends up as `notes.txt`.
 *
 * The path and suffix list travel in FB_ROOT / FB_SUFFIXES rather than on the
 * command line, so names with spaces or shell metacharacters cannot break it.
 */
export function stripBakSuffix(
  scriptPath: string,
  targetPath: string,
  suffixes: string[] = [".bak"]
): Promise<StripResult> {
  return new Promise<StripResult>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        env: { ...process.env, FB_ROOT: targetPath, FB_SUFFIXES: suffixes.join(",") },
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (err) => {
      reject(new Error(`PowerShell 无法启动: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell 退出码 ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()) as StripResult);
      } catch {
        reject(new Error(`PowerShell 输出无法解析: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

/** Path of the PowerShell script inside an installed extension folder. */
export function scriptPathFor(extensionPath: string): string {
  return path.join(extensionPath, "scripts", "strip-bak.ps1");
}
