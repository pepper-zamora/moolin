export type LogLevel = "none" | "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[] = ["none", "error", "warn", "info", "debug"];

export function parseLogLevel(raw: string | undefined): LogLevel {
  return raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "none";
}

// Reads "--log-level=<level>" from an argv. Main parses its own command line;
// preload runs in the renderer's process, whose argv carries the flag only
// because main passes it down via additionalArguments (see main.ts).
export function getCliLogLevel(argv: string[]): LogLevel {
  const prefix = "--log-level=";
  const flag = argv.find((arg) => arg.startsWith(prefix));
  return parseLogLevel(flag?.slice(prefix.length));
}

export function isEnabled(configured: LogLevel, level: Exclude<LogLevel, "none">): boolean {
  return LOG_LEVELS.indexOf(configured) >= LOG_LEVELS.indexOf(level);
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
