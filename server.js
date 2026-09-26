const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const SQLiteSessionStore = require('./session-store');
const { AttemptLimiter } = require('./rate-limit');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'report.sid';

if (!SESSION_SECRET) {
  console.error('缺少环境变量 SESSION_SECRET，拒绝启动');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use(session({
  name: COOKIE_NAME,
  secret: SESSION_SECRET,
  store: new SQLiteSessionStore(db),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // 配好 HTTPS 后改成 true
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

const findStudentForLogin = db.prepare('SELECT student_id, password_hash FROM students WHERE student_id = ?');
const findReport = db.prepare(`
  SELECT name, department, join_days, volunteer_hours, activity_count, partner, message, bg_dir, bg_music
  FROM students
  WHERE student_id = ?
`);

// 学号不存在时也走一次 bcrypt，避免用响应耗时探测学号是否存在
const BCRYPT_ROUNDS = 10;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

/* ---------- 防暴力破解 ---------- */
// 同学号 5 次失败锁 10 分钟；同 IP 放宽到 30 次，避免校园网共用出口被一个人拖累
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const studentLimiter = new AttemptLimiter({ maxFailures: 5, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_MS });
const ipLimiter = new AttemptLimiter({ maxFailures: 30, windowMs: LOCK_WINDOW_MS, lockMs: LOCK_MS });

function lockedSeconds(req, studentId) {
  const targets = [
    [studentLimiter, `student:${studentId}`],
    [ipLimiter, `ip:${req.ip}`],
  ];
  let seconds = 0;
  for (const [limiter, key] of targets) {
    const retry = limiter.retryAfterSeconds(key);
    if (retry && retry > seconds) seconds = retry;
  }
  return seconds;
}

function recordFailure(req, studentId) {
  studentLimiter.fail(`student:${studentId}`);
  ipLimiter.fail(`ip:${req.ip}`);
}

function clearFailures(req, studentId) {
  studentLimiter.succeed(`student:${studentId}`);
  ipLimiter.succeed(`ip:${req.ip}`);
}

function lockedResponse(res, seconds) {
  res.status(429).json({ error: `错误次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试` });
}

const updatePassword = db.prepare('UPDATE students SET password_hash = ? WHERE student_id = ?');// 改密码后让其他设备上的会话失效，只保留当前这一个
const deleteOtherSessions = db.prepare(`
  DELETE FROM sessions
  WHERE sid != ? AND json_extract(sess, '$.studentId') = ?
`);

/* ---------- 学员专属的背景图与背景音乐 ---------- */
// 资源放在宿主机的 static/ 下，compose 以只读方式挂进容器，这里直接看文件在不在
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'static');
// 数组顺序即优先级：同一个名字有多个格式时取排在前面的
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.ogg', '.wav'];

function listFiles(dir, extensions) {
  try {
    return fs.readdirSync(dir)
      .filter(name => extensions.includes(path.extname(name).toLowerCase()))
      .sort((a, b) => {
        const priority = extensions.indexOf(path.extname(a).toLowerCase()) - extensions.indexOf(path.extname(b).toLowerCase());
        return priority !== 0 ? priority : a.localeCompare(b);
      });
  } catch {
    return []; // 目录不存在就等于没配资源
  }
}

// 同一个基名下只保留优先级最高的那个文件
function byBasename(files) {
  const map = new Map();
  for (const name of files) {
    const base = path.parse(name).name;
    if (!map.has(base)) map.set(base, name);
  }
  return map;
}

// 用去掉扩展名的文件名作键，页面写 data-bg="01-opening" 即可，扩展名用 jpg/png/webp 都行；
// 学员自己的目录覆盖共享目录
function buildBackgroundMap(studentId, bgDir) {
  const ownDir = bgDir || studentId;
  const result = {};
  for (const name of byBasename(listFiles(path.join(STATIC_DIR, 'images'), IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = `/images/${name}`;
  }
  for (const name of byBasename(listFiles(path.join(STATIC_DIR, 'images', ownDir), IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = `/images/${encodeURIComponent(ownDir)}/${name}`;
  }
  return result;
}

// 显式写了文件名就按它找（写全名优先，只写基名则按格式优先级），否则找与学号同名的音频
function resolveMusicUrl(studentId, bgMusic) {
  const files = listFiles(path.join(STATIC_DIR, 'music'), AUDIO_EXTENSIONS);
  const wanted = bgMusic
    ? (files.includes(bgMusic) ? bgMusic : byBasename(files).get(bgMusic))
    : byBasename(files).get(studentId);
  return wanted ? `/music/${wanted}` : null;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  });
});

app.post('/api/login', async (req, res) => {
  const { studentId, password } = req.body || {};
  if (typeof studentId !== 'string' || typeof password !== 'string' || !studentId.trim() || !password) {
    return res.status(400).json({ error: '请填写学号和密码' });
  }

  const id = studentId.trim();
  const locked = lockedSeconds(req, id);
  if (locked > 0) return lockedResponse(res, locked);

  const student = findStudentForLogin.get(id);
  const matched = await bcrypt.compare(password, student ? student.password_hash : DUMMY_HASH);
  if (!student || !matched) {
    recordFailure(req, id);
    return res.status(401).json({ error: '学号或密码错误' });
  }

  clearFailures(req, id);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: '登录失败，请重试' });
    req.session.studentId = student.student_id;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: '登录失败，请重试' });
      res.json({ success: true });
    });
  });
});

app.post('/api/password', async (req, res) => {
  const studentId = req.session.studentId;
  if (!studentId) return res.status(401).json({ error: '未登录' });

  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写当前密码和新密码' });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: '新密码长度需为 6–64 位' });
  }
  if (newPassword === oldPassword) {
    return res.status(400).json({ error: '新密码不能和当前密码相同' });
  }

  const locked = lockedSeconds(req, studentId);
  if (locked > 0) return lockedResponse(res, locked);

  const student = findStudentForLogin.get(studentId);
  const matched = student ? await bcrypt.compare(oldPassword, student.password_hash) : false;
  if (!matched) {
    recordFailure(req, studentId);
    return res.status(401).json({ error: '当前密码不正确' });
  }

  updatePassword.run(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS), studentId);
  const otherSessionsRemoved = deleteOtherSessions.run(req.sessionID, studentId).changes;
  clearFailures(req, studentId);

  res.json({ success: true, otherSessionsRemoved });
});

app.get('/api/report', (req, res) => {
  const studentId = req.session.studentId;
  if (!studentId) return res.status(401).json({ error: '未登录' });

  const row = findReport.get(studentId);
  if (!row) return res.status(401).json({ error: '未登录' });

  res.json({
    name: row.name,
    department: row.department,
    joinDays: row.join_days,
    volunteerHours: row.volunteer_hours,
    activityCount: row.activity_count,
    partner: row.partner,
    message: row.message,
    backgrounds: buildBackgroundMap(studentId, row.bg_dir),
    music: resolveMusicUrl(studentId, row.bg_music),
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: '退出失败' });
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`年度报告后端已启动，监听端口 ${PORT}`);
});
