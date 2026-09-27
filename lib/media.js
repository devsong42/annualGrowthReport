const fs = require('fs');
const path = require('path');

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'static');

// 数组顺序即优先级：同一个名字有多个格式时取排在前面的
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.ogg', '.wav'];

// 报告 7 屏的背景图槽位，与 static/index.html 里的 data-bg 一一对应
const PAGE_KEYS = ['01-opening', '02-days', '03-hours', '04-activities', '05-partner', '06-message', '07-ending'];

const KINDS = {
  image: { dir: 'images', extensions: IMAGE_EXTENSIONS },
  music: { dir: 'music', extensions: AUDIO_EXTENSIONS },
};

const UNSAFE_SEGMENT = /[/\\:*?"<>|\x00-\x1f]/;

function mediaRoot(kind) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`未知的资源类型：${kind}`);
  return { root: path.join(STATIC_DIR, spec.dir), extensions: spec.extensions };
}

/* ---------- 通用文件列举 ---------- */

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

/* ---------- URL 与抗缓存 ---------- */

// nginx 对 /images/、/music/ 设了 30 天缓存，所以 URL 必须带文件指纹，换图后浏览器才会重新拉
function withVersion(absPath, url) {
  try {
    const stat = fs.statSync(absPath);
    return `${url}?v=${Math.round(stat.mtimeMs)}-${stat.size}`;
  } catch {
    return url;
  }
}

function fileUrl(kind, dir, name) {
  const base = kind === 'music' ? '/music' : '/images';
  return dir ? `${base}/${encodeURIComponent(dir)}/${encodeURIComponent(name)}` : `${base}/${encodeURIComponent(name)}`;
}

/* ---------- 学员报告用：解析出可用资源 ---------- */

// 键是去掉扩展名的文件名（页面写 data-bg="01-opening"），学员目录优先于共享目录
function buildBackgroundMap(studentId, bgDir) {
  const ownDir = isSafeSegment(bgDir) ? bgDir : studentId; // 目录名非法就退回学号，不让脏数据影响渲染
  const result = {};
  const sharedRoot = path.join(STATIC_DIR, 'images');
  for (const name of byBasename(listFiles(sharedRoot, IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = withVersion(path.join(sharedRoot, name), fileUrl('image', null, name));
  }
  const ownRoot = path.join(sharedRoot, ownDir);
  for (const name of byBasename(listFiles(ownRoot, IMAGE_EXTENSIONS)).values()) {
    result[path.parse(name).name] = withVersion(path.join(ownRoot, name), fileUrl('image', ownDir, name));
  }
  return result;
}

// 显式写了文件名就按它找（写全名优先，只写基名则按格式优先级），否则找与学号同名的音频
function resolveMusicFile(studentId, bgMusic) {
  const { root, extensions } = mediaRoot('music');
  const files = listFiles(root, extensions);
  const wanted = bgMusic
    ? (files.includes(bgMusic) ? bgMusic : byBasename(files).get(bgMusic))
    : byBasename(files).get(studentId);
  return wanted || null;
}

function resolveMusicUrl(studentId, bgMusic) {
  const wanted = resolveMusicFile(studentId, bgMusic);
  if (!wanted) return null;
  const { root } = mediaRoot('music');
  return withVersion(path.join(root, wanted), fileUrl('music', null, wanted));
}

/* ---------- 管理面板用：列举与安全写入 ---------- */

function isSafeSegment(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !UNSAFE_SEGMENT.test(value);
}

function isSafeFileName(name, extensions) {
  return isSafeSegment(name) && !name.startsWith('.') && extensions.includes(path.extname(name).toLowerCase());
}

// 目标文件的绝对路径：先名字白名单，再前缀断言（Express 5 会解码路由参数，%2F 会变成 /，不能只信路由形状）
function resolveMediaPath(kind, dir, name) {
  const { root, extensions } = mediaRoot(kind);
  if (dir && !isSafeSegment(dir)) throw new Error('目录名不合法');
  if (!isSafeFileName(name, extensions)) throw new Error(`文件名不合法，只允许 ${extensions.join(' / ')}`);
  const rootResolved = path.resolve(root);
  const base = dir ? path.resolve(rootResolved, dir) : rootResolved;
  if (base !== rootResolved && !base.startsWith(rootResolved + path.sep)) throw new Error('目录越界');
  const target = path.join(base, name);
  if (path.dirname(target) !== base) throw new Error('路径不合法');
  return target;
}

// 先写同目录临时文件再改名：rename 是原子的，nginx 不会读到半个文件
function atomicWrite(target, buffer) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, buffer, { mode: 0o644 });
  fs.renameSync(temp, target);
}

// 列出某个目录下的资源文件（dir 为空表示共享目录）
function listEntries(kind, dir) {
  const { root, extensions } = mediaRoot(kind);
  const base = dir ? path.join(root, dir) : root;
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // 跳过上传中的临时文件
    const full = path.join(base, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    entries.push({
      name,
      key: path.parse(name).name,
      ext: path.extname(name).toLowerCase(),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      url: withVersion(full, fileUrl(kind, dir, name)),
      supported: extensions.includes(path.extname(name).toLowerCase()),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// 删掉不再需要的空目录（例如学员的专属图目录被清空后）
function removeDirIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // 目录不存在或非空都不需要处理
  }
}

module.exports = {
  STATIC_DIR,
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PAGE_KEYS,
  mediaRoot,
  listFiles,
  byBasename,
  buildBackgroundMap,
  resolveMusicFile,
  resolveMusicUrl,
  isSafeSegment,
  isSafeFileName,
  resolveMediaPath,
  atomicWrite,
  listEntries,
  removeDirIfEmpty,
  withVersion,
  fileUrl,
};
