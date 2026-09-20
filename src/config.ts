import { workspace } from "vscode";

export type Settings = {
  /** Extensions whose files keep their own extension and only get an appended suffix. */
  protectedExtensions: string[];
  /** Appended to files whose extension is protected, e.g. `.c1`. */
  protectedSuffix: string;
  /** Appended to every other file, e.g. `.c`. */
  normalSuffix: string;
  /** Suffix used for the backup copies, e.g. `.bak`. */
  backupSuffix: string;
};

const DEFAULTS: Settings = {
  protectedExtensions: [".c", ".h", ".py"],
  protectedSuffix: ".c1",
  normalSuffix: ".c",
  backupSuffix: ".bak",
};

function toSuffix(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith(".") ? s : `.${s}`));
}

export function getSettings(): Settings {
  const cfg = workspace.getConfiguration("fileBackup");

  return {
    protectedExtensions: splitList(
      cfg.get<string>("protectedExtensions", DEFAULTS.protectedExtensions.join(","))
    ),
    protectedSuffix: toSuffix(cfg.get<string>("protectedSuffix", DEFAULTS.protectedSuffix), DEFAULTS.protectedSuffix),
    normalSuffix: toSuffix(cfg.get<string>("normalSuffix", DEFAULTS.normalSuffix), DEFAULTS.normalSuffix),
    backupSuffix: toSuffix(cfg.get<string>("backupSuffix", DEFAULTS.backupSuffix), DEFAULTS.backupSuffix),
  };
}
