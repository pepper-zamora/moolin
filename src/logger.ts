export type LogLevel = "none" | "error" | "warn" | "info" | "debug";

const LEVELS: LogLevel[] = ["none", "error", "warn", "info", "debug"];

export function parseLogLevel(raw: string | undefined): LogLevel {
  return raw !== undefined && (LEVELS as string[]).includes(raw) ? (raw as LogLevel) : "none";
}

// "--log-level=<level>" works identically in main and preload since both see
// the same process.argv (same OS process, different JS execution contexts).
export function getCliLogLevel(argv: string[]): LogLevel {
  const prefix = "--log-level=";
  const flag = argv.find((arg) => arg.startsWith(prefix));
  return parseLogLevel(flag?.slice(prefix.length));
}

export function isEnabled(configured: LogLevel, level: Exclude<LogLevel, "none">): boolean {
  return LEVELS.indexOf(configured) >= LEVELS.indexOf(level);
}

let currentLevel: LogLevel = "none";

export function configureLogger(level: LogLevel): void {
  currentLevel = level;
}

export function log(level: Exclude<LogLevel, "none">, scope: string, ...args: unknown[]): void {
  if (!isEnabled(currentLevel, level)) return;
  const prefix = `[${scope}][${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}
