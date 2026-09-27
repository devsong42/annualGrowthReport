const API = '/api/admin';

const state = {
  meta: null,
  students: [],
  keyword: '',
  media: null,
  mediaStudentId: '',
  preview: { source: null, text: '', file: null },
  editing: null,
};

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text); // 一律 textContent，避免 XSS
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

async function request(path, options = {}) {
  const { method = 'GET', body, raw = false, headers = {} } = options;
  const response = await fetch(`${API}${path}`, {
    method,
    credentials: 'include',
    headers: raw ? headers : (body ? { 'Content-Type': 'application/json' } : undefined),
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应（例如 nginx 的 413/502 页面）走下面的统一报错
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 登录 ---------- */

function showLogin(message) {
  $('#panel').hidden = true;
  $('#loginScreen').hidden = false;
  $('#loginBtn').disabled = false;
  $('#loginBtn').textContent = '登录';
  $('#adminPassword').value = '';
  const box = $('#loginError');
  box.textContent = message || '';
  box.hidden = !message;
}

async function enterPanel() {
  $('#loginScreen').hidden = true;
  $('#panel').hidden = false;
  if (!state.meta) {
    state.meta = await request('/meta');
    $('#headerHint').textContent = state.meta.headers.join('、');
    if (!state.meta.media.writable) {
      const banner = $('#warnBanner');
      banner.textContent = '容器对静态资源目录没有写权限，上传会失败。请检查 docker-compose.yml 里 app 服务的 ./static 挂载是否已去掉 :ro，并执行 docker compose up -d。';
      banner.hidden = false;
    }
  }
  await loadStudents();
  await loadMedia();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#adminPassword').value;
  if (!username || !password) return showLogin('请填写用户名和密码');

  $('#loginBtn').disabled = true;
  $('#loginBtn').textContent = '登录中…';
  try {
    await request('/login', { method: 'POST', body: { username, password } });
    const session = await request('/session');
    $('#whoami').textContent = `已登录：${session.username}`;
    await enterPanel();
  } catch (error) {
    showLogin(error.message);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await request('/logout', { method: 'POST' });
  } catch {
    // 退出失败也回到登录页
  }
  showLogin('已退出登录');
});

/* ---------- 标签页 ---------- */

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `tab-${name}`;
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
}

/* ---------- 成员列表 ---------- */

async function loadStudents() {
  const query = state.keyword ? `?q=${encodeURIComponent(state.keyword)}` : '';
  const data = await request(`/students${query}`);
  state.students = data.items;
  $('#studentCount').textContent = state.keyword
    ? `匹配 ${data.total} 人（显示 ${data.items.length} 人）`
    : `共 ${data.total} 人`;
  renderStudents();
}

function renderStudents() {
  const list = $('#studentList');
  list.textContent = '';
  if (state.students.length === 0) {
    list.append(el('p', 'muted', '没有匹配的成员'));
    return;
  }

  for (const item of state.students) {
    const card = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, `${item.name}（${item.studentId}）`));
    const facts = [
      item.department || '未填部门',
      `加入 ${item.joinDays ?? '-'} 天`,
      `志愿 ${item.volunteerHours ?? '-'} 小时`,
      `活动 ${item.activityCount ?? '-'} 次`,
    ];
    main.append(el('span', 'muted', facts.join(' · ')));

    const tags = el('div', 'tags');
    if (item.bgDir) tags.append(el('span', 'tag', `专属图目录：${item.bgDir}`));
    if (item.bgMusic) tags.append(el('span', 'tag', `音乐：${item.bgMusic}`));
    if (tags.childElementCount > 0) main.append(tags);
    card.append(main);

    const actions = el('div', 'row-actions');
    actions.append(button('编辑', 'ghost', () => openEditor(item)));
    actions.append(button('媒体', 'ghost', () => {
      selectTab('media');
      $('#mediaStudent').value = item.studentId;
      state.mediaStudentId = item.studentId;
      renderMedia();
    }));
    actions.append(button('预览', 'ghost', () => previewReport(item)));
    actions.append(button('删除', 'danger', () => removeStudent(item)));
    card.append(actions);
    list.append(card);
  }
}

let searchTimer = null;
$('#searchInput').addEventListener('input', (event) => {
  state.keyword = event.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadStudents().catch(showError), 300);
});

$('#refreshBtn').addEventListener('click', () => {
  loadStudents().then(loadMedia).catch(showError);
});

function showError(error) {
  window.alert(error.message);
}

/* ---------- 新增 / 编辑 ---------- */

const EDITOR_FIELDS = {
  studentId: '#f_studentId',
  name: '#f_name',
  department: '#f_department',
  joinDays: '#f_joinDays',
  volunteerHours: '#f_volunteerHours',
  activityCount: '#f_activityCount',
  partner: '#f_partner',
  message: '#f_message',
  bgDir: '#f_bgDir',
  bgMusic: '#f_bgMusic',
  password: '#f_password',
};

function openEditor(item) {
  state.editing = item || null;
  $('#editorTitle').textContent = item ? `编辑：${item.name}（${item.studentId}）` : '新增成员';
  $('#f_studentId').readOnly = Boolean(item);
  $('#f_studentId').value = item ? item.studentId : '';
  $('#f_name').value = item ? item.name : '';
  $('#f_department').value = item ? item.department || '' : '';
  $('#f_joinDays').value = item && item.joinDays !== null ? item.joinDays : '';
  $('#f_volunteerHours').value = item && item.volunteerHours !== null ? item.volunteerHours : '';
  $('#f_activityCount').value = item && item.activityCount !== null ? item.activityCount : '';
  $('#f_partner').value = item ? item.partner || '' : '';
  $('#f_message').value = item ? item.message || '' : '';
  $('#f_bgDir').value = item ? item.bgDir || '' : '';
  $('#f_bgMusic').value = item ? item.bgMusic || '' : '';
  $('#f_password').value = '';
  $('#f_password').placeholder = item ? '留空 = 不修改密码' : '留空 = 用学号后六位';
  const message = $('#editorMessage');
  message.hidden = true;
  message.textContent = '';
  $('#editorOverlay').hidden = false;
}

function closeEditor() {
  $('#editorOverlay').hidden = true;
  state.editing = null;
}

$('#editorCancel').addEventListener('click', closeEditor);

function numberOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

$('#editorForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#editorMessage');
  const submit = $('#editorForm button[type="submit"]');
  message.hidden = true;

  const payload = {
    studentId: $('#f_studentId').value.trim(),
    name: $('#f_name').value.trim(),
    department: $('#f_department').value.trim(),
    joinDays: numberOrNull($('#f_joinDays').value),
    volunteerHours: numberOrNull($('#f_volunteerHours').value),
    activityCount: numberOrNull($('#f_activityCount').value),
    partner: $('#f_partner').value.trim(),
    message: $('#f_message').value,
    bgDir: $('#f_bgDir').value.trim(),
    bgMusic: $('#f_bgMusic').value.trim(),
    password: $('#f_password').value,
  };

  if (!payload.studentId) return showEditorMessage('请填写学号');
  if (!payload.name) return showEditorMessage('请填写姓名');

  submit.disabled = true;
  try {
    if (state.editing) {
      // 编辑只提交改动过的字段，避免把没动过的字段一并覆盖
      const before = state.editing;
      const changed = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'studentId') continue;
        const original = before[key] === undefined || before[key] === null ? '' : String(before[key]);
        if (key === 'password' ? value : String(value) !== original) changed[key] = value;
      }
      delete changed.studentId;
      const result = await request(`/students/${encodeURIComponent(before.studentId)}`, { method: 'PUT', body: changed });
      closeEditor();
      await loadStudents();
      await loadMedia();
      if (result.changed.length === 0 && result.otherSessionsRemoved === 0) {
        window.alert('没有任何改动');
      } else {
        const extra = result.otherSessionsRemoved > 0 ? `，并让该学员 ${result.otherSessionsRemoved} 个设备下线` : '';
        window.alert(`已保存：${result.changed.join('、') || '无字段变化'}${extra}`);
      }
    } else {
      const result = await request('/students', { method: 'POST', body: payload });
      closeEditor();
      await loadStudents();
      await loadMedia();
      window.alert(result.usedDefaultPassword ? '已新增，初始密码为学号后六位' : '已新增');
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showEditorMessage(error.message);
  } finally {
    submit.disabled = false;
  }
});

function showEditorMessage(text) {
  const message = $('#editorMessage');
  message.textContent = text;
  message.hidden = false;
}

$('#addStudentBtn').addEventListener('click', () => openEditor(null));

async function removeStudent(item) {
  if (!window.confirm(`确定删除「${item.name}（${item.studentId}）」吗？该操作不可撤销，学员将无法再登录。`)) return;
  try {
    const result = await request(`/students/${encodeURIComponent(item.studentId)}`, { method: 'DELETE' });
    await loadStudents();
    await loadMedia();
    window.alert(`已删除${result.sessionsRemoved > 0 ? `，并注销其 ${result.sessionsRemoved} 个登录会话` : ''}`);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

async function previewReport(item) {
  try {
    const data = await request(`/students/${encodeURIComponent(item.studentId)}/report`);
    $('#reportTitle').textContent = `报告预览：${data.name}（${data.studentId}）`;
    const body = $('#reportBody');
    body.textContent = '';
    for (const [label, value] of [
      ['姓名', data.name],
      ['部门', data.department],
      ['加入天数', data.joinDays],
      ['志愿时长', data.volunteerHours],
      ['活动次数', data.activityCount],
      ['年度伙伴', data.partner],
      ['部长寄语', data.message],
      ['背景图目录', data.bgDir || '（未指定，用学号目录）'],
      ['背景音乐', data.bgMusic || '（未指定，找与学号同名）'],
    ]) {
      body.append(el('div', 'muted', `${label}：${value ?? '-'}`));
    }
    body.append(el('div', 'muted', '—— 实际会加载的资源 ——'));
    for (const key of state.meta.pageKeys) {
      const url = data.backgrounds[key];
      body.append(el('div', null, `${key}：${url || '未配置（用页面渐变）'}`));
    }
    body.append(el('div', null, `背景音乐：${data.music || '未配置'}`));
    $('#reportOverlay').hidden = false;
  } catch (error) {
    showError(error);
  }
}

$('#reportClose').addEventListener('click', () => { $('#reportOverlay').hidden = true; });

/* ---------- 媒体资源 ---------- */

async function loadMedia() {
  state.media = await request('/media');
  const select = $('#mediaStudent');
  const previous = state.mediaStudentId || select.value;
  select.textContent = '';
  for (const item of state.students) {
    const option = el('option', null, `${item.name}（${item.studentId}）`);
    option.value = item.studentId;
    select.append(option);
  }
  if (state.students.length === 0) {
    state.mediaStudentId = '';
  } else {
    const exists = state.students.some(item => item.studentId === previous);
    state.mediaStudentId = exists ? previous : state.students[0].studentId;
    select.value = state.mediaStudentId;
  }
  renderMedia();
}

function pickActive(files, key, extensions) {
  const candidates = files.filter(file => file.key === key && file.supported);
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => extensions.indexOf(a.ext) - extensions.indexOf(b.ext))[0];
}

function renderMedia() {
  if (!state.media) return;
  const extensions = state.meta.extensions.image;
  const student = state.students.find(item => item.studentId === state.mediaStudentId) || null;
  const ownDir = student ? (student.bgDir || student.studentId) : '';
  const ownFiles = (state.media.images.dirs.find(entry => entry.dir === ownDir) || { files: [] }).files;

  $('#ownDirHint').textContent = student
    ? `当前学员：${student.name}（${student.studentId}）；专属目录：images/${ownDir}/${student.bgDir ? '（Excel/编辑里显式指定）' : '（默认用学号）'}`
    : '还没有成员';
  $('#ownDirPath').textContent = ownDir ? `images/${ownDir}/` : 'images/<学号>/';

  renderSlots($('#ownSlots'), state.meta.pageKeys, ownFiles, extensions, 'own', ownDir, student);
  renderSlots($('#sharedSlots'), state.meta.pageKeys, state.media.images.shared, extensions, 'shared', '', student);
  renderMusic(student);
}

function renderSlots(container, keys, files, extensions, scope, dir, student) {
  container.textContent = '';
  for (const key of keys) {
    const active = pickActive(files, key, extensions);
    const card = el('div', 'slot');
    const thumb = el('div', 'thumb');
    if (active) {
      thumb.style.backgroundImage = `url("${active.url}")`;
      thumb.textContent = '';
    } else {
      thumb.textContent = '未配置';
    }
    card.append(thumb);
    card.append(el('div', 'slot-name', key));
    card.append(el('div', `slot-state ${active ? 'on' : 'off'}`, active ? `${active.name}（${Math.round(active.size / 1024)}KB）` : '未配置'));

    // 落选的同基名文件（优先级更低，不会生效）
    const losers = files.filter(file => file.key === key && file.supported && (!active || file.name !== active.name));
    if (losers.length > 0) {
      card.append(el('div', 'slot-state off', `未生效：${losers.map(file => file.name).join('、')}`));
    }

    const actions = el('div', 'slot-actions');
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) uploadImage(file, dir, key, Boolean(active));
    });
    actions.append(input);
    actions.append(button(active ? '替换' : '上传', 'ghost', () => input.click()));
    if (active) {
      actions.append(button('删除', 'danger', () => deleteMedia('image', dir, active.name)));
    }
    card.append(actions);
    container.append(card);
  }
}

async function uploadImage(file, dir, key, overwrite) {
  const extensions = state.meta.extensions.image;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) {
    window.alert(`只支持 ${extensions.join(' / ')} 格式；iPhone 的 HEIC 请先转成 JPG 再传。`);
    return;
  }
  if (file.size > state.meta.limits.image) {
    window.alert(`图片不能超过 ${Math.round(state.meta.limits.image / 1024 / 1024)}MB`);
    return;
  }

  const name = `${key}${ext}`;
  try {
    const result = await upload({ kind: 'image', dir, name, file, overwrite });
    await loadMedia();
    if (result.shadows && result.shadows.length > 0) {
      window.alert(`已上传，但同名的 ${result.shadows.join('、')} 优先级更高，这张图不会生效。\n需要的话请把那个文件删掉。`);
    }
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    if (error.status === 409 && window.confirm('同名文件已存在，要覆盖吗？')) {
      return uploadImage(file, dir, key, true);
    }
    showError(error);
  }
}

async function upload({ kind, dir, name, file, overwrite }) {
  const query = new URLSearchParams({ kind, dir: dir || '', name });
  if (overwrite) query.set('overwrite', '1');
  return request(`/media/upload?${query.toString()}`, {
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
}

async function deleteMedia(kind, dir, name) {
  if (!window.confirm(`确定删除 ${dir ? `${dir}/` : ''}${name} 吗？`)) return;
  try {
    await request(`/media?kind=${kind}&dir=${encodeURIComponent(dir || '')}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadMedia();
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

function renderMusic(student) {
  const box = $('#musicList');
  box.textContent = '';
  const tracks = state.media.music;

  if (student) {
    const current = tracks.find(track => track.usedBy.some(user => user.studentId === student.studentId));
    const line = el('div', 'row-main');
    line.append(el('strong', null, `当前学员使用：${current ? current.name : '未配置音乐'}`));
    if (!current) line.append(el('span', 'muted', '可以上传一首，或把文件名改成学号同名让它自动匹配'));
    const actions = el('div', 'row-actions');
    actions.append(button('恢复默认（找与学号同名）', 'ghost', () => assignMusic(student, null)));
    if (current) actions.append(button('为该学员取消音乐', 'danger', () => assignMusic(student, '', true)));
    const wrap = el('div', 'row');
    wrap.append(line, actions);
    box.append(wrap);
  }

  if (tracks.length === 0) {
    box.append(el('p', 'muted', '音乐库里还没有文件'));
    return;
  }

  for (const track of tracks) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('strong', null, track.name));
    main.append(el('span', 'muted', `${Math.round(track.size / 1024)}KB · 被 ${track.usedBy.length} 人使用${track.usedBy.length ? '：' + track.usedBy.map(user => user.name).join('、') : ''}`));
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = track.url;
    main.append(audio);
    row.append(main);

    const actions = el('div', 'row-actions');
    if (student) {
      actions.append(button(`设为 ${student.name} 的音乐`, 'ghost', () => assignMusic(student, track.name)));
    }
    actions.append(button('删除', 'danger', () => deleteMedia('music', '', track.name)));
    row.append(actions);
    box.append(row);
  }
}

async function assignMusic(student, name, disable = false) {
  try {
    const result = await request(`/students/${encodeURIComponent(student.studentId)}`, {
      method: 'PUT',
      body: { bgMusic: disable ? '' : name }, // 传空串 = 清掉显式指定，回到「找与学号同名」
    });
    await loadStudents();
    await loadMedia();
    window.alert(disable ? '已取消该学员的音乐' : (name ? `已把 ${name} 指定给 ${student.name}` : '已恢复默认规则'));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
}

$('#mediaStudent').addEventListener('change', (event) => {
  state.mediaStudentId = event.target.value;
  renderMedia();
});

$('#uploadMusicBtn').addEventListener('click', async () => {
  const input = $('#musicFile');
  const file = input.files && input.files[0];
  if (!file) return window.alert('请先选择一个音频文件');

  const extensions = state.meta.extensions.music;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!extensions.includes(ext)) return window.alert(`只支持 ${extensions.join(' / ')} 格式`);
  if (file.size > state.meta.limits.music) return window.alert(`音乐不能超过 ${Math.round(state.meta.limits.music / 1024 / 1024)}MB`);

  const student = state.students.find(item => item.studentId === state.mediaStudentId);
  const suggested = student ? `${student.studentId}${ext}` : file.name;
  const name = window.prompt('保存为哪个文件名？（用学号命名可自动归属该学员）', suggested);
  if (!name) return;

  try {
    const result = await upload({ kind: 'music', dir: '', name: name.trim(), file, overwrite: false });
    input.value = '';
    await loadMedia();
    window.alert(`已上传 ${result.file ? result.file.name : name}`);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    if (error.status === 409) {
      if (!window.confirm('同名文件已存在，要覆盖吗？')) return;
      try {
        await upload({ kind: 'music', dir: '', name: name.trim(), file, overwrite: true });
        input.value = '';
        await loadMedia();
        window.alert('已覆盖');
      } catch (err) {
        showError(err);
      }
      return;
    }
    showError(error);
  }
});

/* ---------- 导入 / 导出 ---------- */

function renderPreview(data) {
  const box = $('#previewBox');
  box.textContent = '';
  const counts = data.counts;
  box.append(el('p', 'msg ok', `共 ${counts.total} 行：新增 ${counts.insert} · 更新 ${counts.update} · 无变化 ${counts.unchanged} · 错误 ${counts.error}`
    + `（${counts.defaultPassword} 人将使用初始密码，${counts.setPassword} 人会被重设密码）`));

  const items = el('div', 'preview-items');
  for (const item of data.items) {
    const row = el('div', 'preview-item');
    row.append(el('span', 'muted', `第 ${item.line} 行`));
    row.append(el('span', null, `${item.studentId || '—'} ${item.name || ''}`.trim()));
    row.append(el('span', `badge ${item.action}`, { insert: '新增', update: '更新', unchanged: '无变化', error: '错误' }[item.action] || item.action));
    if (item.changedFields && item.changedFields.length) row.append(el('span', 'muted', `改动：${item.changedFields.join('、')}`));
    if (item.passwordAction === 'set') row.append(el('span', 'muted', '重设密码'));
    if (item.passwordAction === 'default') row.append(el('span', 'muted', '初始密码'));
    if (item.error) row.append(el('span', 'msg error', item.error));
    items.append(row);
  }
  box.append(items);
  if (data.truncated) box.append(el('p', 'muted', '（只展示前 300 行）'));
  for (const error of data.parseErrors || []) {
    box.append(el('p', 'msg error', `第 ${error.line} 行解析失败：${error.message}`));
  }
  if (data.sheetName) box.append(el('p', 'muted', `工作表：${data.sheetName}`));
}

function hasChanges(data) {
  return data.counts.insert + data.counts.update > 0;
}

$('#previewTextBtn').addEventListener('click', async () => {
  const text = $('#importText').value;
  if (!text.trim()) return window.alert('请先粘贴内容');
  try {
    const data = await request('/import/text/preview', { method: 'POST', body: { text } });
    state.preview = { source: 'text', text, file: null };
    renderPreview(data);
    $('#commitTextBtn').disabled = !hasChanges(data);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#commitTextBtn').addEventListener('click', async () => {
  if (state.preview.source !== 'text') return;
  if ($('#importText').value !== state.preview.text) {
    return window.alert('内容在预览后又被改过，请重新预览再导入');
  }
  if (!window.confirm('确认按预览结果写入数据库吗？')) return;
  try {
    const result = await request('/import/text', { method: 'POST', body: { text: state.preview.text } });
    $('#commitTextBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    window.alert(`导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.defaulted ? `，其中 ${result.defaulted} 人使用初始密码` : ''));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#previewExcelBtn').addEventListener('click', async () => {
  const input = $('#excelFile');
  const file = input.files && input.files[0];
  if (!file) return window.alert('请先选择 .xlsx 文件');
  try {
    const data = await request('/import/xlsx/preview', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    state.preview = { source: 'xlsx', text: '', file };
    renderPreview(data);
    $('#commitExcelBtn').disabled = !hasChanges(data);
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

$('#commitExcelBtn').addEventListener('click', async () => {
  const file = state.preview.file;
  if (state.preview.source !== 'xlsx' || !file) return;
  if (!window.confirm('确认按预览结果写入数据库吗？')) return;
  try {
    const result = await request('/import/xlsx', {
      method: 'POST',
      raw: true,
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: await file.arrayBuffer(),
    });
    $('#commitExcelBtn').disabled = true;
    await loadStudents();
    await loadMedia();
    window.alert(`导入完成：写入 ${result.imported} 条，无变化 ${result.unchanged} 条，跳过 ${result.skipped.length} 条`
      + (result.defaulted ? `，其中 ${result.defaulted} 人使用初始密码` : ''));
  } catch (error) {
    if (error.status === 401) return showLogin('登录已过期，请重新登录');
    showError(error);
  }
});

/* ---------- 启动 ---------- */

(async function start() {
  try {
    const session = await request('/session');
    $('#whoami').textContent = `已登录：${session.username}`;
    await enterPanel();
  } catch (error) {
    if (error.status !== 401) showLogin('无法连接服务器，请刷新重试');
  }
})();
