#!/usr/bin/env node
// 管理员账号管理（密码只以 bcrypt 哈希入库，不进任何配置文件）
// 用法：
//   node scripts/set-admin.js <用户名>              # 从标准输入读一行作为密码
//   node scripts/set-admin.js <用户名> <密码>        # 直接把密码写在命令里（会进 shell 历史）
//   node scripts/set-admin.js <用户名> --delete      # 删除管理员
//   node scripts/set-admin.js --list                # 列出所有管理员
const bcrypt = require('bcryptjs');
const fs = require('fs');
const db = require('../db');

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 64;

const upsertAdmin = db.prepare(`
  INSERT INTO admins (username, password_hash, created_at, password_changed_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(username) DO UPDATE SET
    password_hash = excluded.password_hash,
    password_changed_at = datetime('now')
`);
const findAdmin = db.prepare('SELECT username FROM admins WHERE username = ?');
const listAdmins = db.prepare('SELECT username, created_at, password_changed_at, last_login_at FROM admins ORDER BY username');
const deleteAdmin = db.prepare('DELETE FROM admins WHERE username = ?');
// 改密或删号后，让这个管理员已登录的会话立即失效
const deleteAdminSessions = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.admin.name') = ?");

function usage() {
  console.log(`管理员账号管理

  node scripts/set-admin.js <用户名>           从标准输入读一行作为密码（推荐）
  node scripts/set-admin.js <用户名> <密码>     直接指定密码
  node scripts/set-admin.js <用户名> --delete   删除管理员
  node scripts/set-admin.js --list             列出所有管理员

用户名：字母/数字/下划线/点/短横线，1–32 位
密码：${MIN_PASSWORD}–${MAX_PASSWORD} 位`);
}

function readPasswordFromStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(1024);
  while (chunks.length < 4) {
    const bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    if (chunks.some(chunk => chunk.includes(10))) break;
  }
  return Buffer.concat(chunks).toString('utf8').split('\n')[0].replace(/\r$/, '');
}

function checkUsername(username) {
  if (!USERNAME_PATTERN.test(username)) {
    console.error('用户名不合法：只允许字母、数字、下划线、点、短横线，长度 1–32');
    process.exit(1);
  }
}

function checkPassword(password) {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    console.error(`密码长度需为 ${MIN_PASSWORD}–${MAX_PASSWORD} 位`);
    process.exit(1);
  }
}

function list() {
  const rows = listAdmins.all();
  if (rows.length === 0) {
    console.log('还没有管理员账号。用 node scripts/set-admin.js <用户名> 创建一个');
    return;
  }
  console.log(`共 ${rows.length} 个管理员：`);
  for (const row of rows) {
    console.log(`  ${row.username}  创建 ${row.created_at}  改密 ${row.password_changed_at || '-'}  末次登录 ${row.last_login_at || '-'}`);
  }
}

function remove(username) {
  const info = deleteAdmin.run(username);
  if (info.changes === 0) {
    console.error(`没有找到管理员 ${username}`);
    process.exit(1);
  }
  const sessions = deleteAdminSessions.run(username).changes;
  console.log(`已删除管理员 ${username}，同时注销其 ${sessions} 个登录会话`);
}

function setPassword(username, password) {
  const isNew = !findAdmin.get(username);
  upsertAdmin.run(username, bcrypt.hashSync(password, BCRYPT_ROUNDS));
  const sessions = deleteAdminSessions.run(username).changes;
  console.log(isNew ? `已创建管理员 ${username}` : `已更新管理员 ${username} 的密码`);
  if (sessions > 0) console.log(`同时注销了该管理员 ${sessions} 个已登录会话`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }
  if (args[0] === '--list') {
    list();
    return;
  }

  const username = args[0];
  checkUsername(username);

  if (args[1] === '--delete') {
    remove(username);
    return;
  }

  const password = args[1] || readPasswordFromStdin();
  checkPassword(password);
  setPassword(username, password);
}

try {
  main();
} catch (err) {
  console.error(`执行失败：${err.message}`);
  process.exit(1);
}
