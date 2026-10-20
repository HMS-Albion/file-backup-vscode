import { spawn } from "child_process";
import * as path from "path";

/**
 * The JSON a shell script answers with. The scripts under `scripts/` take their
 * input through environment variables and reply with a single JSON object, so a
 * caller never has to quote a path into a command line.
 */
export type ShellOutput = Record<string, unknown>;

/**
 * Runs a PowerShell script and parses the JSON it prints on stdout.
 *
 * The script's own input rides in environment variables, and its answer is a
 * single JSON object on stdout; anything on stderr is only used to explain a
 * non-zero exit code.
 */
export function runShellScript<T = ShellOutput>(
  scriptPath: string,
  env: NodeJS.ProcessEnv = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { env: { ...process.env, ...env }, windowsHide: true }
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
        resolve(JSON.parse(stdout.trim()) as T);
      } catch {
        reject(new Error(`PowerShell 输出无法解析: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

/** Path of a PowerShell script inside an installed extension folder. */
export function scriptPathFor(extensionPath: string, fileName = "strip-bak.ps1"): string {
  return path.join(extensionPath, "scripts", fileName);
}
