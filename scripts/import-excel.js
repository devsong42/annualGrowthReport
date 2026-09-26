#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const db = require('../db');

const HEADERS = ['学号', '密码', '姓名', '部门', '加入天数', '志愿时长', '活动次数', '年度伙伴', '部长寄语'];
const REQUIRED_HEADERS = ['学号', '姓名'];
const BCRYPT_ROUNDS = 10;

const findExisting = db.prepare('SELECT password_hash FROM students WHERE student_id = ?');

const upsert = db.prepare(`
  INSERT INTO students (
    student_id, name, department, join_days, volunteer_hours,
    activity_count, partner, message, password_hash
  ) VALUES (
    @student_id, @name, @department, @join_days, @volunteer_hours,
    @activity_count, @partner, @message, @password_hash
  )
  ON CONFLICT(student_id) DO UPDATE SET
    name = excluded.name,
    department = excluded.department,
    join_days = excluded.join_days,
    volunteer_hours = excluded.volunteer_hours,
    activity_count = excluded.activity_count,
    partner = excluded.partner,
    message = excluded.message,
    password_hash = excluded.password_hash
`);

function usage() {
  console.log(`用法：
  node scripts/import-excel.js <数据文件.xlsx>     按学号导入或更新学员数据
  node scripts/import-excel.js --template [路径]   生成空白模板（默认 import/students-template.xlsx）

Excel 首行为表头，列名：${HEADERS.join('、')}
密码列留空表示保留数据库中已有的密码；新增学员必须填密码。`);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function writeTemplate(target) {
  const sheet = XLSX.utils.aoa_to_sheet([
    HEADERS,
    ['2021001', 'init123456', '张三', '技术部', 365, 120, 15, '李四', '愿你保持热爱'],
    ['2021002', '', '王五', '宣传部', 280, 85, 10, '赵六', '未来可期'],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'students');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  XLSX.writeFile(book, target);
  console.log(`模板已生成：${target}`);
  console.log('提示：第二行的密码列故意留空，用于演示「保留原密码」；正式使用时请删掉示例行。');
}

function readRows(file) {
  const book = XLSX.readFile(file);
  const sheetName = book.SheetNames.includes('students') ? 'students' : book.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '' });
  console.log(`读取工作表「${sheetName}」，共 ${rows.length} 行数据`);
  return rows;
}

function toRecord(row) {
  const text = key => String(row[key] ?? '').trim();

  const studentId = text('学号');
  if (!studentId) return { error: '缺少学号' };

  const name = text('姓名');
  if (!name) return { error: '缺少姓名' };

  const password = text('密码');
  let passwordHash = null;
  if (password) {
    passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  } else {
    const existing = findExisting.get(studentId);
    if (!existing) return { error: `新增学员 ${studentId} 没有填密码` };
    passwordHash = existing.password_hash;
  }

  return {
    value: {
      student_id: studentId,
      name,
      department: text('部门'),
      join_days: toInt(text('加入天数')),
      volunteer_hours: toNumber(text('志愿时长')),
      activity_count: toInt(text('活动次数')),
      partner: text('年度伙伴'),
      message: text('部长寄语'),
      password_hash: passwordHash,
    },
  };
}

function importFile(file) {
  const rows = readRows(file);
  if (rows.length === 0) throw new Error('没有读到数据行，请检查表头是否在第 1 行');

  const present = Object.keys(rows[0]);
  const missing = REQUIRED_HEADERS.filter(h => !present.includes(h));
  if (missing.length > 0) throw new Error(`缺少必需的列：${missing.join('、')}`);

  const skipped = [];
  let imported = 0;

  const run = db.transaction(() => {
    rows.forEach((row, index) => {
      const { value, error } = toRecord(row);
      if (error) {
        skipped.push(`第 ${index + 2} 行：${error}`);
        return;
      }
      upsert.run(value);
      imported += 1;
    });
  });
  run();

  console.log(`导入完成：成功 ${imported} 条，跳过 ${skipped.length} 条`);
  skipped.forEach(line => console.log(`  - ${line}`));
  console.log(`数据库：${db.name}`);
}

function main() {
  const args = process.argv.slice(2);

  const templateFlag = args.indexOf('--template');
  if (templateFlag !== -1) {
    writeTemplate(args[templateFlag + 1] || 'import/students-template.xlsx');
    return;
  }

  const file = args[0];
  if (!file) {
    usage();
    process.exit(1);
  }

  importFile(file);
}

try {
  main();
} catch (err) {
  console.error(`导入失败：${err.message}`);
  process.exit(1);
}
