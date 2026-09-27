const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const records = require('../lib/student-records');
const media = require('../lib/media');
const { AttemptLimiter } = require('../rate-limit');
const { UndoBuffer } = require('../lib/undo-buffer');

const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // 管理员会话 12 小时，比学员的 7 天短
const JSON_LIMIT = '2mb'; // 全局 express.json() 默认只有 100kb，几百人的批量文本会被 413
const UPLOAD_LIMIT = '10mb';
const KIND_LIMITS = { image: 5 * 1024 * 1024, music: 8 * 1024 * 1024 };
const LIST_LIMIT_MAX = 200;
const PREVIEW_ITEMS_MAX = 300;

// 用户名不存在时也走一次 bcrypt，避免用响应耗时探测管理员是否存在
const DUMMY_HASH = bcrypt.hashSync('not-a-real-admin-password', 10);

// 各字段的中文表头，单条新增/编辑与批量导入共用同一套规则
const FIELD_TO_HEADER = {
  name: '姓名',
  department: '部门',
  joinDays: '加入天数',
  volunteerHours: '志愿时长',
  activityCount: '活动次数',
  partner: '年度伙伴',
  message: '部长寄语',
  bgDir: '背景图目录',
  bgMusic: '背景音乐',
  password: '密码',
};

function toStudentDto(row) {
  return {
    studentId: row.student_id,
    name: row.name,
    department: row.department,
    joinDays: row.join_days,
    volunteerHours: row.volunteer_hours,
    activityCount: row.activity_count,
    partner: row.partner,
    message: row.message,
    bgDir: row.bg_dir,
    bgMusic: row.bg_music,
  };
}

module.exports = function createAdminRouter({ db }) {
  const router = express.Router();

  /* ---------- 预编译语句 ---------- */
  const findAdmin = db.prepare('SELECT username, password_hash FROM admins WHERE username = ?');
  const adminExists = db.prepare('SELECT 1 FROM admins WHERE username = ?');
  const markAdminLogin = db.prepare("UPDATE admins SET last_login_at = datetime('now') WHERE username = ?");

  const findStudent = db.prepare('SELECT * FROM students WHERE student_id = ?');
  const listStudents = db.prepare('SELECT * FROM students ORDER BY student_id LIMIT ? OFFSET ?');
  const countStudents = db.prepare('SELECT count(*) AS total FROM students');
  const searchStudents = db.prepare('SELECT * FROM students WHERE instr(student_id, ?) > 0 OR instr(name, ?) > 0 ORDER BY student_id LIMIT ? OFFSET ?');
  const countSearchStudents = db.prepare('SELECT count(*) AS total FROM students WHERE instr(student_id, ?) > 0 OR instr(name, ?) > 0');
  const deleteStudent = db.prepare('DELETE FROM students WHERE student_id = ?');
  const deleteStudentSessions = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.studentId') = ?");
  const deleteOtherStudentSessions = db.prepare("DELETE FROM sessions WHERE sid != ? AND json_extract(sess, '$.studentId') = ?");

  /* ---------- 撤销：改动前先留一份记录快照 ---------- */
  const undos = new UndoBuffer();
  // SELECT * 出来的行正好和 UPSERT_SQL 的命名参数一一对应，可直接回写
  const restoreStudent = db.prepare(records.UPSERT_SQL);
  const snapshotStudents = ids => ids.map(id => findStudent.get(id)).filter(Boolean);

  /* ---------- 管理员登录限流（独立实例，避免和学员互相连坐） ---------- */
  const adminUserLimiter = new AttemptLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });
  const adminIpLimiter = new AttemptLimiter({ maxFailures: 10, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 });

  function lockedSeconds(req, username) {
    let seconds = 0;
    const targets = [
      [adminUserLimiter, `admin:${username}`],
      [adminIpLimiter, `adminip:${req.ip}`],
    ];
    for (const [limiter, key] of targets) {
      const retry = limiter.retryAfterSeconds(key);
      if (retry && retry > seconds) seconds = retry;
    }
    return seconds;
  }

  function requireAdmin(req, res, next) {
    const admin = req.session && req.session.admin;
    if (!admin || !adminExists.get(admin.name)) {
      if (req.session) delete req.session.admin; // 账号被删掉后立即失效
      return res.status(401).json({ error: '管理员未登录' });
    }
    next();
  }

  const jsonBody = express.json({ limit: JSON_LIMIT });
  const rawBody = express.raw({ type: 'application/octet-stream', limit: UPLOAD_LIMIT });

  /* ---------- 登录与会话 ---------- */

  router.post('/login', jsonBody, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: '请填写用户名和密码' });
    }

    const name = username.trim();
    const locked = lockedSeconds(req, name);
    if (locked > 0) return res.status(429).json({ error: `错误次数过多，请 ${Math.ceil(locked / 60)} 分钟后再试` });

    const admin = findAdmin.get(name);
    const matched = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !matched) {
      adminUserLimiter.fail(`admin:${name}`);
      adminIpLimiter.fail(`adminip:${req.ip}`);
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    adminUserLimiter.succeed(`admin:${name}`);
    adminIpLimiter.succeed(`adminip:${req.ip}`);
    markAdminLogin.run(name);

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: '登录失败，请重试' });
      req.session.admin = { name, since: Date.now() };
      req.session.cookie.maxAge = ADMIN_SESSION_MS;
      req.session.save(err2 => {
        if (err2) return res.status(500).json({ error: '登录失败，请重试' });
        res.json({ success: true, username: name });
      });
    });
  });

  router.post('/logout', (req, res) => {
    if (req.session) delete req.session.admin; // 只退管理面板，不影响同一浏览器里的学员登录
    req.session.save(() => res.json({ success: true }));
  });

  router.get('/session', requireAdmin, (req, res) => {
    res.json({ username: req.session.admin.name, since: req.session.admin.since });
  });

  router.get('/meta', requireAdmin, (req, res) => {
    const canWrite = dir => {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    const imageRoot = media.mediaRoot('image').root;
    const musicRoot = media.mediaRoot('music').root;
    res.json({
      headers: records.HEADERS,
      pageKeys: media.PAGE_KEYS,
      limits: { image: KIND_LIMITS.image, music: KIND_LIMITS.music, rows: records.MAX_ROWS },
      extensions: { image: media.IMAGE_EXTENSIONS, music: media.AUDIO_EXTENSIONS },
      media: { imageRoot, musicRoot, writable: canWrite(imageRoot) && canWrite(musicRoot) },
    });
  });

  /* ---------- 成员列表与增删改 ---------- */

  router.get('/students', requireAdmin, (req, res) => {
    const keyword = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || LIST_LIMIT_MAX, 1), LIST_LIMIT_MAX);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const rows = keyword
      ? searchStudents.all(keyword, keyword, limit, offset)
      : listStudents.all(limit, offset);
    const total = keyword
      ? countSearchStudents.get(keyword, keyword).total
      : countStudents.get().total;

    res.json({ total, items: rows.map(toStudentDto) });
  });

  // 单条新增与编辑都走 records 的同一套规则（密码三规则、字段校验、upsert）
  function planSingle(studentId, body) {
    const row = { 学号: studentId, __line: 1 };
    for (const [key, header] of Object.entries(FIELD_TO_HEADER)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) row[header] = body[key];
    }
    return row;
  }

  router.post('/students', requireAdmin, jsonBody, async (req, res, next) => {
    try {
      const body = req.body || {};
      const plan = records.planRecords(db, [planSingle(body.studentId, body)]);
      const item = plan.items[0];
      if (item.error) return res.status(400).json({ error: item.error });
      if (item.action !== 'insert') return res.status(409).json({ error: '该学号已存在，请改用编辑' });

      await records.fillPasswords([item]);
      records.applyRecords(db, [item]);
      res.status(201).json({ success: true, action: 'insert', usedDefaultPassword: item.passwordAction === 'default' });
    } catch (err) {
      next(err);
    }
  });

  router.put('/students/:studentId', requireAdmin, jsonBody, async (req, res, next) => {
    try {
      const studentId = req.params.studentId;
      const existing = findStudent.get(studentId);
      if (!existing) return res.status(404).json({ error: '成员不存在' });

      // 以库中现有数据为底，只覆盖请求里明确给出的字段（没给的字段不动）
      const body = req.body || {};
      const merged = {
        studentId,
        name: existing.name,
        department: existing.department,
        joinDays: existing.join_days,
        volunteerHours: existing.volunteer_hours,
        activityCount: existing.activity_count,
        partner: existing.partner,
        message: existing.message,
        bgDir: existing.bg_dir,
        bgMusic: existing.bg_music,
        password: '',
      };
      for (const key of Object.keys(FIELD_TO_HEADER)) {
        if (Object.prototype.hasOwnProperty.call(body, key)) merged[key] = body[key];
      }

      const plan = records.planRecords(db, [planSingle(merged.studentId, merged)]);
      const item = plan.items[0];
      if (item.error) return res.status(400).json({ error: item.error });
      if (item.action === 'unchanged') return res.json({ success: true, changed: [], otherSessionsRemoved: 0 });

      await records.fillPasswords([item]);
      const before = snapshotStudents([studentId]); // 改动前留底，供「撤销」还原
      records.applyRecords(db, [item]);

      let otherSessionsRemoved = 0;
      const changed = [...item.changedFields];
      if (item.passwordAction === 'set' || item.passwordAction === 'default') {
        changed.push('密码');
        // 管理员改密码后，把这个学员在其他设备上的会话全部下线
        otherSessionsRemoved = deleteOtherStudentSessions.run(req.sessionID, studentId).changes;
      }
      res.json({ success: true, changed, otherSessionsRemoved, undo: undos.remember('编辑成员', before) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/students/:studentId', requireAdmin, (req, res) => {
    const before = snapshotStudents([req.params.studentId]);
    const info = deleteStudent.run(req.params.studentId);
    if (info.changes === 0) return res.status(404).json({ error: '成员不存在' });
    const sessionsRemoved = deleteStudentSessions.run(req.params.studentId).changes;
    res.json({ success: true, sessionsRemoved, undo: undos.remember('删除成员', before) });
  });

  // 撤销上一次改动（删除成员、批量修改、批量删除、单条编辑都支持）
  router.post('/students/undo', requireAdmin, jsonBody, (req, res) => {
    const token = String((req.body && req.body.token) || '');
    const entry = undos.take(token);
    if (!entry) return res.status(404).json({ error: '撤销已过期或已使用过' });

    const run = db.transaction(() => {
      for (const row of entry.rows) restoreStudent.run(row);
    });
    run();
    res.json({ success: true, label: entry.label, restored: entry.rows.length });
  });

  /* ---------- 批量操作 ---------- */

  const BATCH_LIMIT = 500;
  // 允许批量设置的字段（学号/姓名/密码不能批量改，密码走独立的「重置」）
  const BATCH_FIELDS = ['department', 'joinDays', 'volunteerHours', 'activityCount', 'partner', 'message', 'bgDir', 'bgMusic'];

  function readBatchIds(body) {
    const list = Array.isArray(body && body.studentIds) ? body.studentIds : [];
    return list.map(id => String(id).trim()).filter(Boolean);
  }

  function removeSessionsFor(studentIds) {
    if (studentIds.length === 0) return 0;
    const placeholders = studentIds.map(() => '?').join(',');
    return db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.studentId') IN (${placeholders})`).run(...studentIds).changes;
  }

  // 批量修改字段 / 批量把密码重置为「学号后六位」
  router.post('/students/batch', requireAdmin, jsonBody, async (req, res, next) => {
    try {
      const body = req.body || {};
      const ids = readBatchIds(body);
      if (ids.length === 0) return res.status(400).json({ error: '请先勾选成员' });
      if (ids.length > BATCH_LIMIT) return res.status(400).json({ error: `一次最多处理 ${BATCH_LIMIT} 人` });

      const set = body.set && typeof body.set === 'object' ? body.set : {};
      const fields = Object.keys(set);
      const unknown = fields.filter(key => !BATCH_FIELDS.includes(key));
      if (unknown.length > 0) return res.status(400).json({ error: `不支持批量修改这些字段：${unknown.join('、')}` });

      const resetPassword = body.resetPasswordToDefault === true;
      if (fields.length === 0 && !resetPassword) return res.status(400).json({ error: '没有要修改的内容' });

      const before = snapshotStudents(ids); // 改动前的快照，供「撤销」还原

      const items = [];
      const skipped = [];
      for (const studentId of ids) {
        const existing = findStudent.get(studentId);
        if (!existing) {
          skipped.push({ studentId, message: '成员不存在' });
          continue;
        }
        const merged = toStudentDto(existing);
        merged.password = resetPassword ? studentId.slice(-6) : '';
        for (const key of fields) merged[key] = set[key];

        const plan = records.planRecords(db, [planSingle(merged.studentId, merged)]);
        const item = plan.items[0];
        if (item.error) {
          skipped.push({ studentId, message: item.error });
          continue;
        }
        items.push(item);
      }

      await records.fillPasswords(items); // 重置密码可能要算几百次哈希，必须异步
      const result = records.applyRecords(db, items);

      const passwordResetIds = items
        .filter(item => item.passwordAction === 'set' || item.passwordAction === 'default')
        .map(item => item.record.student_id);
      const otherSessionsRemoved = removeSessionsFor(passwordResetIds);

      res.json({
        success: true,
        updated: result.imported,
        unchanged: result.unchanged,
        skipped,
        passwordReset: passwordResetIds.length,
        otherSessionsRemoved,
        undo: undos.remember('批量修改', before),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/students/batch-delete', requireAdmin, jsonBody, (req, res) => {
    const ids = readBatchIds(req.body);
    if (ids.length === 0) return res.status(400).json({ error: '请先勾选成员' });
    if (ids.length > BATCH_LIMIT) return res.status(400).json({ error: `一次最多删除 ${BATCH_LIMIT} 人` });

    const before = snapshotStudents(ids); // 删除前留底，供「撤销」还原
    const skipped = [];
    let deleted = 0;
    const run = db.transaction(() => {
      for (const studentId of ids) {
        const info = deleteStudent.run(studentId);
        if (info.changes === 0) skipped.push({ studentId, message: '成员不存在' });
        else deleted += 1;
      }
    });
    run();

    const sessionsRemoved = removeSessionsFor(ids);
    res.json({ success: true, deleted, sessionsRemoved, skipped, undo: undos.remember('批量删除', before) });
  });

  // 预览某个学员看到的报告（含解析后的背景图与音乐），用于排查资源是否配对
  router.get('/students/:studentId/report', requireAdmin, (req, res) => {
    const row = findStudent.get(req.params.studentId);
    if (!row) return res.status(404).json({ error: '成员不存在' });
    res.json({
      studentId: row.student_id,
      name: row.name,
      department: row.department,
      joinDays: row.join_days,
      volunteerHours: row.volunteer_hours,
      activityCount: row.activity_count,
      partner: row.partner,
      message: row.message,
      bgDir: row.bg_dir,
      bgMusic: row.bg_music,
      backgrounds: media.buildBackgroundMap(row.student_id, row.bg_dir),
      music: media.resolveMusicUrl(row.student_id, row.bg_music),
    });
  });

  /* ---------- 批量导入（文本 / Excel） ---------- */

  function buildPreview(plan, extra = {}) {
    return {
      counts: plan.counts,
      items: plan.items.slice(0, PREVIEW_ITEMS_MAX).map(item => ({
        line: item.line,
        studentId: item.studentId || '',
        name: item.name || '',
        action: item.action,
        changedFields: item.changedFields || [],
        passwordAction: item.passwordAction || null,
        error: item.error || null,
      })),
      truncated: plan.items.length > PREVIEW_ITEMS_MAX,
      ...extra,
    };
  }

  function missingText(req, res) {
    if (!req.body || typeof req.body.text !== 'string' || !req.body.text.trim()) {
      res.status(400).json({ error: '没有可导入的内容' });
      return true;
    }
    return false;
  }

  router.post('/import/text/preview', requireAdmin, jsonBody, (req, res) => {
    if (missingText(req, res)) return;
    const { rows, errors } = records.parseText(req.body.text);
    if (rows.length === 0) return res.status(400).json({ error: errors.length ? '解析失败' : '没有可导入的内容', parseErrors: errors });
    res.json(buildPreview(records.planRecords(db, rows), { parseErrors: errors }));
  });

  router.post('/import/text', requireAdmin, jsonBody, async (req, res, next) => {
    try {
      if (missingText(req, res)) return;
      const { rows, errors } = records.parseText(req.body.text);
      if (rows.length === 0) return res.status(400).json({ error: '没有可导入的内容', parseErrors: errors });

      const plan = records.planRecords(db, rows);
      await records.fillPasswords(plan.items); // 异步逐行哈希，避免阻塞其它请求
      const result = records.applyRecords(db, plan.items);
      res.json({ success: true, imported: result.imported, unchanged: result.unchanged, defaulted: result.defaulted, skipped: result.skipped, parseErrors: errors });
    } catch (err) {
      next(err);
    }
  });

  function readExcel(req, res) {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: '没有收到文件内容' });
      return null;
    }
    try {
      const parsed = records.parseExcelBuffer(req.body);
      const missing = records.missingHeaders(parsed.rows);
      if (missing.length > 0) {
        res.status(400).json({ error: `缺少必需的列：${missing.join('、')}` });
        return null;
      }
      if (parsed.rows.length === 0) {
        res.status(400).json({ error: '没有读到数据行，请检查表头是否在第 1 行' });
        return null;
      }
      return parsed;
    } catch (err) {
      res.status(400).json({ error: `无法解析这个 Excel：${err.message}` });
      return null;
    }
  }

  router.post('/import/xlsx/preview', requireAdmin, rawBody, (req, res) => {
    const parsed = readExcel(req, res);
    if (!parsed) return;
    res.json(buildPreview(records.planRecords(db, parsed.rows), { sheetName: parsed.sheetName }));
  });

  router.post('/import/xlsx', requireAdmin, rawBody, async (req, res, next) => {
    try {
      const parsed = readExcel(req, res);
      if (!parsed) return;
      const plan = records.planRecords(db, parsed.rows);
      await records.fillPasswords(plan.items);
      const result = records.applyRecords(db, plan.items);
      res.json({ success: true, imported: result.imported, unchanged: result.unchanged, defaulted: result.defaulted, skipped: result.skipped, sheetName: parsed.sheetName });
    } catch (err) {
      next(err);
    }
  });

  /* ---------- 导出 ---------- */

  function sendWorkbook(res, buffer, filename) {
    res.attachment(filename);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  }

  router.get('/export/xlsx', requireAdmin, (req, res) => {
    sendWorkbook(res, records.exportBuffer(listStudents.all(LIST_LIMIT_MAX * 100, 0)), '学员名单.xlsx');
  });

  router.get('/export/template.xlsx', requireAdmin, (req, res) => {
    sendWorkbook(res, records.templateBuffer(), '导入模板.xlsx');
  });

  /* ---------- 媒体资源 ---------- */

  router.get('/media', requireAdmin, (req, res) => {
    const students = db.prepare('SELECT student_id, name, bg_dir, bg_music FROM students ORDER BY student_id').all();

    // 谁在用哪个图目录 / 哪首歌
    const dirUsage = {};
    const musicUsage = {};
    for (const student of students) {
      const dir = student.bg_dir || student.student_id;
      if (!dirUsage[dir]) dirUsage[dir] = [];
      dirUsage[dir].push({ studentId: student.student_id, name: student.name, via: student.bg_dir ? 'explicit' : 'default' });

      const musicFile = media.resolveMusicFile(student.student_id, student.bg_music);
      if (musicFile) {
        if (!musicUsage[musicFile]) musicUsage[musicFile] = [];
        musicUsage[musicFile].push({ studentId: student.student_id, name: student.name, via: student.bg_music ? 'explicit' : 'default' });
      }
    }

    const imageRoot = media.mediaRoot('image').root;
    const dirs = [];
    try {
      for (const entry of fs.readdirSync(imageRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        dirs.push({ dir: entry.name, files: media.listEntries('image', entry.name), usedBy: dirUsage[entry.name] || [] });
      }
    } catch {
      // 目录不存在就是没资源
    }

    res.json({
      pageKeys: media.PAGE_KEYS,
      images: {
        shared: media.listEntries('image', null),
        dirs,
      },
      music: media.listEntries('music', null).map(file => ({ ...file, usedBy: musicUsage[file.name] || [] })),
    });
  });

  function decodeHeaderName(req) {
    const raw = String(req.headers['x-file-name'] || '');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  router.post('/media/upload', requireAdmin, rawBody, (req, res, next) => {
    try {
      const kind = String(req.query.kind || '');
      if (!['image', 'music'].includes(kind)) return res.status(400).json({ error: '资源类型只能是 image 或 music' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: '没有收到文件内容' });
      if (req.body.length > KIND_LIMITS[kind]) {
        const mb = Math.round(KIND_LIMITS[kind] / 1024 / 1024);
        return res.status(413).json({ error: `文件太大，${kind === 'image' ? '图片' : '音乐'}不能超过 ${mb}MB` });
      }

      const dir = String(req.query.dir || '').trim();
      if (kind === 'music' && dir) return res.status(400).json({ error: '背景音乐不支持子目录' });

      const wanted = String(req.query.name || '').trim() || decodeHeaderName(req);
      if (!media.isSafeSegment(wanted)) return res.status(400).json({ error: '文件名不合法（不能包含斜杠、.. 等字符）' });

      let target;
      try {
        target = media.resolveMediaPath(kind, dir, wanted);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const exists = fs.existsSync(target);
      if (exists && req.query.overwrite !== '1') {
        return res.status(409).json({ error: '同名文件已存在', existing: wanted });
      }

      media.atomicWrite(target, req.body);

      const entries = media.listEntries(kind, dir);
      const saved = entries.find(entry => entry.name === wanted) || null;
      const key = path.parse(wanted).name;
      // 同一基名下优先级更高的格式会遮蔽刚上传的文件，明确指出是哪些文件（否则会误以为「传了没反应」）
      const { extensions } = media.mediaRoot(kind);
      const myRank = extensions.indexOf(path.extname(wanted).toLowerCase());
      const shadows = entries
        .filter(entry => entry.key === key && entry.name !== wanted && entry.supported && extensions.indexOf(entry.ext) < myRank)
        .map(entry => entry.name);
      res.json({ success: true, overwritten: exists, file: saved, shadows });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/media', requireAdmin, (req, res) => {
    const kind = String(req.query.kind || '');
    if (!['image', 'music'].includes(kind)) return res.status(400).json({ error: '资源类型只能是 image 或 music' });

    const dir = String(req.query.dir || '').trim();
    const name = String(req.query.name || '').trim();
    if (kind === 'music' && dir) return res.status(400).json({ error: '背景音乐不支持子目录' });
    if (!media.isSafeSegment(name)) return res.status(400).json({ error: '文件名不合法（不能包含斜杠、.. 等字符）' });

    let target;
    try {
      target = media.resolveMediaPath(kind, dir, name);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!fs.existsSync(target)) return res.status(404).json({ error: '文件不存在' });
    fs.unlinkSync(target);
    if (dir) media.removeDirIfEmpty(path.dirname(target));
    res.json({ success: true });
  });

  return router;
};
