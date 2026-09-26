const { Store } = require('express-session');

const DEFAULT_TTL = 1000 * 60 * 60 * 24 * 7;

class SQLiteSessionStore extends Store {
  constructor(db, options = {}) {
    super();
    this.ttl = options.ttl || DEFAULT_TTL;
    this.getStmt = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.saveStmt = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)');
    this.touchStmt = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStmt = db.prepare('DELETE FROM sessions WHERE expire < ?');

    this.timer = setInterval(() => this.cleanup(), 1000 * 60 * 30);
    this.timer.unref();
  }

  expiryOf(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : this.ttl);
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return callback(null, null);
      if (row.expire < Date.now()) {
        this.destroyStmt.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.saveStmt.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStmt.run(this.expiryOf(sess), sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  cleanup() {
    this.cleanupStmt.run(Date.now());
  }
}

module.exports = SQLiteSessionStore;
