/**
 * Structured Logger for System Synthesis
 *
 * A lightweight structured JSON logger built on top of pino concepts
 * but without the dependency — uses native console + JSON serialization.
 *
 * Features:
 * - Structured JSON output in production, pretty-print in development
 * - Child loggers with inherited context
 * - Request timing helpers
 * - Log levels: trace, debug, info, warn, error, fatal
 */

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m",  // gray
  debug: "\x1b[36m",  // cyan
  info: "\x1b[32m",   // green
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  fatal: "\x1b[35m",  // magenta
};

const RESET = "\x1b[0m";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const MIN_LEVEL = LEVEL_VALUES[(process.env.LOG_LEVEL as LogLevel) || "info"];

interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  [key: string]: unknown;
}

export class Logger {
  private context: Record<string, unknown>;

  constructor(context: Record<string, unknown> = {}) {
    this.context = context;
  }

  /**
   * Create a child logger with additional context fields.
   */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger({ ...this.context, ...bindings });
  }

  /**
   * Start a timer — returns a function that logs elapsed ms.
   */
  startTimer(label: string): () => void {
    const start = performance.now();
    return () => {
      const durationMs = Math.round(performance.now() - start);
      this.info(`${label} completed`, { durationMs });
    };
  }

  // ── Log methods ──

  trace(msg: string, data?: Record<string, unknown>) {
    this.log("trace", msg, data);
  }

  debug(msg: string, data?: Record<string, unknown>) {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>) {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>) {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>) {
    this.log("error", msg, data);
  }

  fatal(msg: string, data?: Record<string, unknown>) {
    this.log("fatal", msg, data);
  }

  // ── Internal ──

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVEL_VALUES[level] < MIN_LEVEL) return;

    const entry: LogEntry = {
      level,
      msg,
      time: new Date().toISOString(),
      ...this.context,
      ...data,
    };

    if (IS_PRODUCTION) {
      // Structured JSON — one line per log, ideal for log aggregators
      const output = JSON.stringify(entry);
      if (level === "error" || level === "fatal") {
        process.stderr.write(output + "\n");
      } else {
        process.stdout.write(output + "\n");
      }
    } else {
      // Pretty-print for development
      const color = LEVEL_COLORS[level];
      const tag = `${color}${level.toUpperCase().padEnd(5)}${RESET}`;
      const ctx = { ...this.context, ...data };
      const ctxStr = Object.keys(ctx).length > 0
        ? ` ${LEVEL_COLORS.trace}${JSON.stringify(ctx)}${RESET}`
        : "";
      const fn = level === "error" || level === "fatal"
        ? console.error
        : level === "warn"
        ? console.warn
        : console.log;
      fn(`  ${tag} ${msg}${ctxStr}`);
    }
  }
}

// ── Singleton ──

export const logger = new Logger({ service: "system-synthesis" });

// ── Express middleware ──

import type { Request, Response, NextFunction } from "express";

/**
 * Request logging middleware.
 * Logs method, path, status code, and response time.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();
  const reqLogger = logger.child({
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - start);
    const level: LogLevel = res.statusCode >= 500
      ? "error"
      : res.statusCode >= 400
      ? "warn"
      : "info";

    reqLogger[level]("request completed", {
      status: res.statusCode,
      durationMs,
    });
  });

  next();
}
