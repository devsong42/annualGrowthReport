const BACKGROUND_DIR = 'images/';
const FALLBACK = {
  partner: '（暂无）',
  message: '（暂无寄语）',
};

const loginScreen = document.querySelector('#loginScreen');
const reportScreen = document.querySelector('#reportScreen');
const loginForm = document.querySelector('#loginForm');
const loginBtn = document.querySelector('#loginBtn');
const loginError = document.querySelector('#loginError');
const logoutBtn = document.querySelector('#logoutBtn');
const studentIdInput = document.querySelector('#studentId');
const passwordInput = document.querySelector('#password');

let swiper = null;
let reportData = null;

async function request(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(path, {
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

function loadBackgrounds() {
  document.querySelectorAll('.page[data-bg]').forEach((page) => {
    const url = `${BACKGROUND_DIR}${page.dataset.bg}`;
    const image = new Image();
    image.onload = () => {
      page.style.backgroundImage = `url("${url}")`;
      page.classList.add('has-bg');
    };
    image.src = url;
  });
}

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
  loginScreen.hidden = false;
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
  reportScreen.hidden = false;
  hideLoginError();
  loadBackgrounds();

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
