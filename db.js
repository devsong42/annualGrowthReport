const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'report.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT,
    join_days INTEGER,
    volunteer_hours REAL,
    activity_count INTEGER,
    partner TEXT,
    message TEXT,
    password_hash TEXT NOT NULL,
    bg_dir TEXT,
    bg_music TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT,
    expire INTEGER
  );

  CREATE TABLE IF NOT EXISTS admins (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    password_changed_at TEXT,
    last_login_at TEXT
  );
`);

// CREATE TABLE IF NOT EXISTS 不会给已存在的表补字段，老库需要手动补列
const studentColumns = db.prepare('PRAGMA table_info(students)').all().map(column => column.name);
for (const column of ['bg_dir', 'bg_music']) {
  if (!studentColumns.includes(column)) db.exec(`ALTER TABLE students ADD COLUMN ${column} TEXT`);
}

module.exports = db;
