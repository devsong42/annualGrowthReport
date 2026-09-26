const DEFAULTS = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 10 * 60 * 1000,
};

// 进程内计数（单体应用够用）：同一 key 在窗口内失败 maxFailures 次就锁定一段时间
class AttemptLimiter {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.entries = new Map();
    this.timer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.timer.unref();
  }

  touch(key) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { count: 0, firstAt: now, lockedUntil: 0 };
      this.entries.set(key, entry);
    }

    if (entry.lockedUntil && entry.lockedUntil <= now) {
      entry.lockedUntil = 0;
      entry.count = 0;
      entry.firstAt = now;
    }
    if (!entry.lockedUntil && now - entry.firstAt > this.options.windowMs) {
      entry.count = 0;
      entry.firstAt = now;
    }
    return entry;
  }

  // 被锁定时返回剩余秒数，否则返回 null
  retryAfterSeconds(key) {
    const entry = this.entries.get(key);
    if (!entry || !entry.lockedUntil) return null;
    const remain = entry.lockedUntil - Date.now();
    return remain > 0 ? Math.ceil(remain / 1000) : null;
  }

  fail(key) {
    const entry = this.touch(key);
    entry.count += 1;
    if (entry.count >= this.options.maxFailures) {
      entry.lockedUntil = Date.now() + this.options.lockMs;
      return true;
    }
    return false;
  }

  succeed(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      const locked = entry.lockedUntil > now;
      const stale = now - entry.firstAt > this.options.windowMs;
      if (!locked && stale) this.entries.delete(key);
    }
  }
}

module.exports = { AttemptLimiter };
