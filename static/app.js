const FALLBACK = {
  partner: '（暂无）',
  message: '（暂无寄语）',
};

const MUSIC_PREF_KEY = 'report.bgm';
const MUSIC_VOLUME = 0.6;

const loginScreen = document.querySelector('#loginScreen');
const reportScreen = document.querySelector('#reportScreen');
const loginForm = document.querySelector('#loginForm');
const loginBtn = document.querySelector('#loginBtn');
const loginError = document.querySelector('#loginError');
const logoutBtn = document.querySelector('#logoutBtn');
const changePasswordBtn = document.querySelector('#changePasswordBtn');
const passwordScreen = document.querySelector('#passwordScreen');
const passwordForm = document.querySelector('#passwordForm');
const passwordBtn = document.querySelector('#passwordBtn');
const passwordBack = document.querySelector('#passwordBack');
const passwordError = document.querySelector('#passwordError');
const passwordOk = document.querySelector('#passwordOk');
const oldPasswordInput = document.querySelector('#oldPassword');
const newPasswordInput = document.querySelector('#newPassword');
const confirmPasswordInput = document.querySelector('#confirmPassword');
const studentIdInput = document.querySelector('#studentId');
const passwordInput = document.querySelector('#password');
const bgm = document.querySelector('#bgm');
const musicToggle = document.querySelector('#musicToggle');

let swiper = null;
let reportData = null;

// 手机端常见的一类失败：复用中的 keep-alive 连接刚好被服务端关闭，
// 请求发到已关闭的 socket 上会直接抛 TypeError（Failed to fetch），
// 且不会到达服务器日志。这类情况自动重试一次即可恢复。
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      return await fetch(url, init);
    } catch {
      throw new Error('网络连接失败，请重试；若反复失败，请切换网络或换一个浏览器打开');
    }
  }
}

async function request(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetchWithRetry(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 响应（例如 Nginx 的 502 页面）走下面的统一报错
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 入场动画 ---------- */

function playAnimations(root) {
  root.querySelectorAll('[data-animate]').forEach((node) => {
    const effect = node.dataset.animate;
    node.style.setProperty('--animate-duration', node.dataset.duration || '0.9s');
    node.style.setProperty('--animate-delay', node.dataset.delay || '0ms');
    node.classList.remove('animate__animated', `animate__${effect}`);
    void node.offsetWidth; // 强制重排，保证再次进入同一页时动画重播
    node.classList.add('animate__animated', `animate__${effect}`);
  });
}

/* ---------- 大数字滚动 ---------- */

function countUp(node, target) {
  const value = Number(target);
  const end = Number.isFinite(value) ? value : 0;
  const decimals = Number.isInteger(end) ? 0 : 1;
  const duration = 1200;
  const startedAt = performance.now();

  function frame(now) {
    const progress = Math.min((now - startedAt) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (progress < 1) {
      node.textContent = (end * eased).toFixed(decimals);
      requestAnimationFrame(frame);
    } else {
      node.textContent = end.toFixed(decimals);
    }
  }

  node.textContent = (0).toFixed(decimals);
  requestAnimationFrame(frame);
}

function playPage(slide) {
  if (!slide) return;
  playAnimations(slide);
  slide.querySelectorAll('[data-count]').forEach((node) => {
    countUp(node, reportData ? reportData[node.dataset.count] : 0);
  });
}

/* ---------- 渲染 ---------- */

function renderReport(data) {
  reportData = data;
  document.querySelectorAll('[data-field]').forEach((node) => {
    const value = data[node.dataset.field];
    const empty = value === null || value === undefined || value === '';
    node.textContent = empty ? FALLBACK[node.dataset.field] || '' : String(value);
  });
}

// 后端只返回确实存在的图片地址，这里不用再试探
function applyBackgrounds(backgrounds) {
  document.querySelectorAll('.page[data-bg]').forEach((page) => {
    const url = backgrounds && backgrounds[page.dataset.bg];
    if (!url) return; // 没配图就保留页面自带的渐变
    page.style.backgroundImage = `url("${url}")`;
    page.classList.add('has-bg');
  });
}

/* ---------- 背景音乐 ---------- */

function musicPreference() {
  try {
    return localStorage.getItem(MUSIC_PREF_KEY);
  } catch {
    return null; // 隐私模式下读不到，按默认（自动播放）处理
  }
}

function rememberMusicPreference(value) {
  try {
    localStorage.setItem(MUSIC_PREF_KEY, value);
  } catch {
    // 写不进去不影响本次播放
  }
}

function setMusicState(playing) {
  musicToggle.classList.toggle('is-playing', playing);
  musicToggle.setAttribute('aria-label', playing ? '关闭背景音乐' : '播放背景音乐');
}

function playMusic() {
  bgm.play().then(() => setMusicState(true)).catch(() => setMusicState(false));
}

function stopMusic() {
  bgm.pause();
  setMusicState(false);
}

function setupMusic(url) {
  musicToggle.hidden = !url;
  if (!url) {
    bgm.removeAttribute('src');
    setMusicState(false);
    return;
  }
  if (bgm.getAttribute('src') !== url) bgm.setAttribute('src', url);
  bgm.volume = MUSIC_VOLUME;
  // 上次是自己关掉的，这次就不要自动响起来
  if (musicPreference() === 'off') setMusicState(false);
  else playMusic();
}

musicToggle.addEventListener('click', () => {
  if (bgm.paused) {
    rememberMusicPreference('on');
    playMusic();
  } else {
    rememberMusicPreference('off');
    stopMusic();
  }
});

// 文件缺失或解码失败时，把开关一起藏掉
bgm.addEventListener('error', () => {
  musicToggle.hidden = true;
});

/* ---------- 屏幕切换 ---------- */

function showLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = false;
}

function hideLoginError() {
  loginError.textContent = '';
  loginError.hidden = true;
}

function showLogin(message) {
  reportScreen.hidden = true;
  passwordScreen.hidden = true;
  loginScreen.hidden = false;
  stopMusic();
  loginBtn.disabled = false;
  loginBtn.textContent = '进入报告';
  passwordInput.value = '';
  if (message) showLoginError(message);
  else hideLoginError();
  playAnimations(loginScreen);
  if (swiper) swiper.slideTo(0, 0);
}

function enterReport(data) {
  renderReport(data);
  loginScreen.hidden = true;
  passwordScreen.hidden = true;
  reportScreen.hidden = false;
  hideLoginError();
  applyBackgrounds(data.backgrounds);
  setupMusic(data.music);

  if (swiper) {
    swiper.slideTo(0, 0);
    playPage(swiper.slides[0]);
    return;
  }

  swiper = new Swiper('#reportSwiper', {
    direction: 'vertical',
    speed: 800,
    resistanceRatio: 0.6,
    mousewheel: true,
    observer: true,
    observeParents: true,
    pagination: { el: '.swiper-pagination', clickable: true },
    on: {
      slideChangeTransitionStart(instance) {
        playPage(instance.slides[instance.activeIndex]);
      },
    },
  });
}

/* ---------- 修改密码 ---------- */

function showPasswordError(message) {
  passwordOk.hidden = true;
  passwordError.textContent = message;
  passwordError.hidden = false;
}

function showPasswordOk(message) {
  passwordError.hidden = true;
  passwordOk.textContent = message;
  passwordOk.hidden = false;
}

function resetPasswordForm() {
  oldPasswordInput.value = '';
  newPasswordInput.value = '';
  confirmPasswordInput.value = '';
  passwordError.hidden = true;
  passwordOk.hidden = true;
  passwordBtn.disabled = false;
  passwordBtn.textContent = '保存新密码';
}

function showChangePassword() {
  resetPasswordForm();
  reportScreen.hidden = true;
  passwordScreen.hidden = false;
  playAnimations(passwordScreen);
}

function backToReport() {
  passwordScreen.hidden = true;
  reportScreen.hidden = false;
  if (swiper) {
    swiper.update();
    playPage(swiper.slides[swiper.activeIndex]);
  }
}

/* ---------- 登录与退出 ---------- */

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideLoginError();

  const studentId = studentIdInput.value.trim();
  const password = passwordInput.value;
  if (!studentId || !password) {
    showLoginError('请填写学号和密码');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '正在打开…';

  try {
    await request('/api/login', { method: 'POST', body: { studentId, password } });
    const data = await request('/api/report');
    enterReport(data);
  } catch (error) {
    showLoginError(error.message);
    loginBtn.disabled = false;
    loginBtn.textContent = '进入报告';
  }
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  try {
    await request('/api/logout', { method: 'POST' });
  } catch {
    // 服务端退出失败也回到登录页，避免卡在报告里
  }
  logoutBtn.disabled = false;
  showLogin('已退出登录');
});

changePasswordBtn.addEventListener('click', showChangePassword);
passwordBack.addEventListener('click', backToReport);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordError.hidden = true;
  passwordOk.hidden = true;

  const oldPassword = oldPasswordInput.value;
  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (!oldPassword || !newPassword || !confirmPassword) return showPasswordError('请把三项都填上');
  if (newPassword.length < 6 || newPassword.length > 64) return showPasswordError('新密码长度需为 6–64 位');
  if (newPassword !== confirmPassword) return showPasswordError('两次输入的新密码不一致');
  if (newPassword === oldPassword) return showPasswordError('新密码不能和当前密码相同');

  passwordBtn.disabled = true;
  passwordBtn.textContent = '保存中…';

  try {
    const result = await request('/api/password', { method: 'POST', body: { oldPassword, newPassword } });
    resetPasswordForm();
    const extra = result && result.otherSessionsRemoved > 0 ? '，其他设备上的登录已失效' : '';
    showPasswordOk(`密码修改成功${extra}`);
  } catch (error) {
    passwordBtn.disabled = false;
    passwordBtn.textContent = '保存新密码';
    if (error.message === '未登录') {
      showLogin('登录已过期，请重新登录');
      return;
    }
    showPasswordError(error.message);
  }
});

/* ---------- 启动 ---------- */

(async function start() {
  playAnimations(loginScreen);
  try {
    const data = await request('/api/report');
    enterReport(data);
  } catch (error) {
    if (error.status !== 401) {
      showLoginError('无法连接服务器，请刷新重试');
    }
  }
})();
