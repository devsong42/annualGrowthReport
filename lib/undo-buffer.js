// 撤销缓冲区：把改动前的成员记录暂存在内存里，短时间内可以一键还原。
// 管理面板在删除/批量修改后会在轻提示上给出「撤销」按钮，就是靠这里的数据。
// 只存最近若干次改动，过期或超出上限自动丢弃；重启容器即清空（与限流器同一思路，够用且简单）。
const { randomUUID } = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 20;

class UndoBuffer {
  constructor(options = {}) {
    this.ttl = options.ttl || DEFAULT_TTL_MS;
    this.max = options.max || MAX_ENTRIES;
    this.entries = new Map();
    this.timer = setInterval(() => this.cleanup(), 60 * 1000);
    this.timer.unref();
  }

  // rows 为空时返回 null（没有可撤销的内容）
  remember(label, rows) {
    if (!rows || rows.length === 0) return null;
    this.cleanup();

    const token = randomUUID();
    this.entries.set(token, { label, rows, expiresAt: Date.now() + this.ttl });

    // 超上限时丢掉最旧的一条
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return { token, label, rows: rows.length, expiresInMs: this.ttl };
  }

  // 取出即作废，防止重复撤销；过期视为无效
  take(token) {
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.entries.delete(token);
    return entry.expiresAt > Date.now() ? entry : null;
  }

  cleanup() {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

module.exports = { UndoBuffer };
