function now() {
  return Date.now();
}

function normalizeLevel(level) {
  const l = String(level || "info").toLowerCase().trim();
  if (l === "warn" || l === "warning") return "warn";
  if (l === "error") return "error";
  return "info";
}

class Logger {
  constructor({ onLog } = {}) {
    this.onLog = typeof onLog === "function" ? onLog : null;
  }

  _emit(level, scope, message, extra) {
    const entry = {
      ts: now(),
      level: normalizeLevel(level),
      scope: String(scope || "app"),
      message: String(message || ""),
    };
    if (extra && typeof extra === "object") {
      entry.extra = extra;
    }
    try {
      if (this.onLog) this.onLog(entry);
    } catch {
      // ignore
    }
    const prefix = `[${entry.level}] ${entry.scope}:`;
    if (entry.level === "error") console.error(prefix, entry.message);
    else if (entry.level === "warn") console.warn(prefix, entry.message);
    else console.log(prefix, entry.message);
  }

  info(scope, message, extra) {
    this._emit("info", scope, message, extra);
  }

  warn(scope, message, extra) {
    this._emit("warn", scope, message, extra);
  }

  error(scope, message, extra) {
    this._emit("error", scope, message, extra);
  }
}

module.exports = { Logger };

