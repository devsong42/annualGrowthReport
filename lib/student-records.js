// 「成员数据」的唯一规则来源：CLI 导入、面板文本批量、面板单条增删改都走这里，
// 保证三处行为完全一致。纯 JS（只依赖 xlsx/bcryptjs/media），不 require db，
// 这样在宿主机上也能直接跑逻辑测试。
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const media = require('./media');

const HEADERS = ['学号', '密码', '姓名', '部门', '加入天数', '志愿时长', '活动次数', '年度伙伴', '部长寄语', '背景图目录', '背景音乐'];
const REQUIRED_HEADERS = ['学号', '姓名'];
const BCRYPT_ROUNDS = 10;
const MAX_ROWS = 5000;

// 数据库字段 ↔ 中文表头，用于计算「哪些字段变了」
const FIELD_LABELS = {
  student_id: '学号',
  name: '姓名',
  department: '部门',
  join_days: '加入天数',
  volunteer_hours: '志愿时长',
  activity_count: '活动次数',
  partner: '年度伙伴',
  message: '部长寄语',
  bg_dir: '背景图目录',
  bg_music: '背景音乐',
};

const text = value => String(value ?? '').trim();

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/* ---------- 解析：文本 ---------- */

// 按 CSV 规则切分：支持双引号包裹（字段里可以含分隔符），分隔符可以是 , ，\t
function splitLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '，' || ch === '\t') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map(field => field.trim());
}

// 每行一名学员，字段顺序与 Excel 列一致；空行与 # 开头忽略；首行含「学号」时按列名映射
function parseText(input) {
  const rows = [];
  const errors = [];

  const rawLines = String(input ?? '').split(/\r?\n/);
  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const fields = splitLine(raw);
    if (fields.includes('学号')) return; // 表头行直接跳过

    if (fields.length > HEADERS.length) {
      errors.push({ line: index + 1, message: `该行有 ${fields.length} 个字段，超过 ${HEADERS.length} 列（字段里含逗号请用双引号包起来）` });
      return;
    }

    const row = { __line: index + 1 };
    HEADERS.forEach((label, i) => {
      row[label] = fields[i] ?? '';
    });
    rows.push(row);
  });

  if (rows.length > MAX_ROWS) {
    return { rows: rows.slice(0, MAX_ROWS), errors: [...errors, { line: 0, message: `一次最多导入 ${MAX_ROWS} 行，超出部分已忽略` }] };
  }
  return { rows, errors };
}

/* ---------- 解析：Excel ---------- */

function parseExcelBuffer(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  if (book.SheetNames.length === 0) throw new Error('Excel 里没有可读的工作表');

  const sheetName = book.SheetNames.includes('students') ? 'students' : book.SheetNames[0];
  const raw = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '' });
  const rows = raw.map((row, index) => ({ ...row, __line: index + 2 })); // Excel 第 1 行是表头

  if (rows.length > MAX_ROWS) throw new Error(`一次最多导入 ${MAX_ROWS} 行`);
  return { rows, sheetName };
}

function missingHeaders(rows) {
  if (rows.length === 0) return [...REQUIRED_HEADERS];
  const present = Object.keys(rows[0]);
  return REQUIRED_HEADERS.filter(header => !present.includes(header));
}

/* ---------- 校验与预演 ---------- */

// 纯字段映射与校验，不做密码决策（密码决策需要知道库里有没有这个人）
function toRecord(row) {
  const studentId = text(row['学号']);
  if (!studentId) return { error: '缺少学号' };
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(studentId)) return { error: '学号只能包含字母、数字、下划线、短横线（1–32 位）' };

  const name = text(row['姓名']);
  if (!name) return { error: '缺少姓名' };

  const bgDir = text(row['背景图目录']) || null;
  if (bgDir && !media.isSafeSegment(bgDir)) return { error: '背景图目录不合法（不能含斜杠、`..` 等字符）' };

  const bgMusic = text(row['背景音乐']) || null;
  if (bgMusic && !media.isSafeSegment(bgMusic)) return { error: '背景音乐文件名不合法（不能含斜杠、`..` 等字符）' };

  return {
    plainPassword: text(row['密码']),
    value: {
      student_id: studentId,
      name,
      department: text(row['部门']),
      join_days: toInt(text(row['加入天数'])),
      volunteer_hours: toNumber(text(row['志愿时长'])),
      activity_count: toInt(text(row['活动次数'])),
      partner: text(row['年度伙伴']),
      message: text(row['部长寄语']),
      bg_dir: bgDir,
      bg_music: bgMusic,
      password_hash: null,
    },
  };
}

function sameValue(a, b) {
  const left = a === null || a === undefined ? '' : String(a);
  const right = b === null || b === undefined ? '' : String(b);
  return left === right;
}

// 只读预演：算出每行是新增/更新/无变化/错误，以及密码怎么处理。不写库。
function planRecords(db, rows) {
  const findStudent = db.prepare('SELECT * FROM students WHERE student_id = ?');
  const items = [];
  const counts = { total: rows.length, insert: 0, update: 0, unchanged: 0, error: 0, defaultPassword: 0, setPassword: 0 };

  rows.forEach((row, index) => {
    const line = row.__line || index + 2;
    const parsed = toRecord(row);

    if (parsed.error) {
      counts.error += 1;
      items.push({ line, error: parsed.error, action: 'error' });
      return;
    }

    const { value, plainPassword } = parsed;
    const existing = findStudent.get(value.student_id);
    let passwordAction;

    if (plainPassword) {
      passwordAction = 'set';
      counts.setPassword += 1;
    } else if (existing) {
      passwordAction = 'keep';
      value.password_hash = existing.password_hash;
    } else {
      passwordAction = 'default'; // 新学员初始密码 = 学号后六位
      counts.defaultPassword += 1;
    }

    // 新增的行不需要逐个列字段（整行都是新的），只给更新行算变更字段
    const changedFields = !existing
      ? []
      : Object.keys(FIELD_LABELS).filter(key => !sameValue(value[key], existing[key]));

    let action;
    if (!existing) action = 'insert';
    else if (changedFields.length > 0 || passwordAction !== 'keep') action = 'update';
    else action = 'unchanged';

    counts[action] += 1;
    items.push({
      line,
      studentId: value.student_id,
      name: value.name,
      action,
      changedFields: changedFields.map(key => FIELD_LABELS[key]),
      passwordAction,
      plainPassword: plainPassword || (passwordAction === 'default' ? value.student_id.slice(-6) : null),
      record: value,
      error: null,
    });
  });

  return { items, counts };
}

/* ---------- 哈希与写入 ---------- */

// 面板用：异步哈希，逐行让出事件循环，避免几百号人把站点卡死
async function fillPasswords(items) {
  for (const item of items) {
    if (item.record && item.record.password_hash === null && item.plainPassword) {
      item.record.password_hash = await bcrypt.hash(item.plainPassword, BCRYPT_ROUNDS);
    }
  }
  return items;
}

// CLI 用：没有并发压力，同步更快
function fillPasswordsSync(items) {
  for (const item of items) {
    if (item.record && item.record.password_hash === null && item.plainPassword) {
      item.record.password_hash = bcrypt.hashSync(item.plainPassword, BCRYPT_ROUNDS);
    }
  }
  return items;
}

const UPSERT_SQL = `
  INSERT INTO students (
    student_id, name, department, join_days, volunteer_hours,
    activity_count, partner, message, password_hash, bg_dir, bg_music
  ) VALUES (
    @student_id, @name, @department, @join_days, @volunteer_hours,
    @activity_count, @partner, @message, @password_hash, @bg_dir, @bg_music
  )
  ON CONFLICT(student_id) DO UPDATE SET
    name = excluded.name,
    department = excluded.department,
    join_days = excluded.join_days,
    volunteer_hours = excluded.volunteer_hours,
    activity_count = excluded.activity_count,
    partner = excluded.partner,
    message = excluded.message,
    password_hash = excluded.password_hash,
    bg_dir = excluded.bg_dir,
    bg_music = excluded.bg_music
`;

// 一个事务里写完：要么全成功，要么全回滚
function applyRecords(db, items) {
  const upsert = db.prepare(UPSERT_SQL);
  const run = db.transaction(() => {
    let imported = 0;
    let unchanged = 0;
    let defaulted = 0;
    const skipped = [];

    for (const item of items) {
      if (item.error) {
        skipped.push({ line: item.line, message: item.error });
        continue;
      }
      if (item.action === 'unchanged') {
        unchanged += 1;
        continue;
      }
      upsert.run(item.record);
      imported += 1;
      if (item.passwordAction === 'default') defaulted += 1;
    }

    return { imported, unchanged, defaulted, skipped };
  });

  return run();
}

/* ---------- 导出 ---------- */

function toSheetRows(students) {
  return students.map(student => ({
    学号: student.student_id,
    密码: '', // 库里只有哈希，导不出来，留空正好命中「保留原密码」规则
    姓名: student.name,
    部门: student.department ?? '',
    加入天数: student.join_days ?? '',
    志愿时长: student.volunteer_hours ?? '',
    活动次数: student.activity_count ?? '',
    年度伙伴: student.partner ?? '',
    部长寄语: student.message ?? '',
    背景图目录: student.bg_dir ?? '',
    背景音乐: student.bg_music ?? '',
  }));
}

function buildWorkbook(sheetRows) {
  const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: HEADERS, skipHeader: false });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'students');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function exportBuffer(students) {
  return buildWorkbook(toSheetRows(students));
}

function templateBuffer() {
  return buildWorkbook([
    { 学号: '2021001', 密码: 'init123456', 姓名: '张三', 部门: '技术部', 加入天数: 365, 志愿时长: 120, 活动次数: 15, 年度伙伴: '李四', 部长寄语: '愿你保持热爱', 背景图目录: '', 背景音乐: '' },
    { 学号: '2021002', 密码: '', 姓名: '王五', 部门: '宣传部', 加入天数: 280, 志愿时长: 85, 活动次数: 10, 年度伙伴: '赵六', 部长寄语: '未来可期', 背景图目录: '', 背景音乐: '' },
  ]);
}

module.exports = {
  HEADERS,
  REQUIRED_HEADERS,
  MAX_ROWS,
  parseText,
  parseExcelBuffer,
  missingHeaders,
  planRecords,
  toRecord,
  fillPasswords,
  fillPasswordsSync,
  applyRecords,
  exportBuffer,
  templateBuffer,
};
