const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const SQLiteSessionStore = require('./session-store');

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
  SELECT name, department, join_days, volunteer_hours, activity_count, partner, message
  FROM students
  WHERE student_id = ?
`);

// 学号不存在时也走一次 bcrypt，避免用响应耗时探测学号是否存在
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

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

  const student = findStudentForLogin.get(studentId.trim());
  const matched = await bcrypt.compare(password, student ? student.password_hash : DUMMY_HASH);
  if (!student || !matched) {
    return res.status(401).json({ error: '学号或密码错误' });
  }

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: '登录失败，请重试' });
    req.session.studentId = student.student_id;
    req.session.save(err2 => {
      if (err2) return res.status(500).json({ error: '登录失败，请重试' });
      res.json({ success: true });
    });
  });
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
