# 年度成长报告（annualGrowthReport）项目上下文

> 来源：DeepSeek 对话 https://chat.deepseek.com/share/evy5mqtjsubs1ca95s
> 本文件是对话结论的结构化提取，作为后续开发的上下文基线。

---

## 1. 项目目标

为学员提供「个人专属年度成长报告」手机端网页：输入学号 + 密码登录，查看自己的年度回顾页面。
交互风格借鉴网易云 / B站 / 小红书年度回顾：整屏上下滑动翻页、每页独立背景图、文字淡入动画。

## 2. 需求清单

**功能需求**

- 手机端优先，上下滑动整屏翻页（Swiper.js）
- 每页匹配独立背景图，文字自带淡入/上浮动画（Animate.css）
- 学号 + 密码登录，仅能查看本人数据
- 报告约 7–8 页：欢迎页 → 开场页（姓名 + 部门）→ 加入天数 → 志愿时长 → 活动次数 → 年度伙伴 → 部长寄语 → 结尾页
- 数据与页面完全分离：每学年只替换数据源，不改代码

**数据字段（每名学员）**

学号、密码、姓名、部门、加入天数、志愿时长、活动次数、年度伙伴、部长寄语

## 3. 方案演进（对话结论）

| 阶段 | 用户补充 | 结论 |
|---|---|---|
| 1 | 初始需求 | 纯前端单 HTML：Swiper + Animate.css + SheetJS 读本地 Excel，双击运行 |
| 2 | 「不要执着于纯前端，有云服务器可用」 | 改为带后端：数据与身份验证放服务端 |
| 3 | 「还想搭配 docker」 | 最终采用 Docker 编排部署 |

**最终定案：Docker + Node.js/Express + Nginx + SQLite 的后端方案。**

纯前端方案被否定的原因：密码技术上讲可被离线破解、全部学员数据暴露在 Excel 中、`file://` 协议下 `fetch` 读取本地文件会被浏览器拦截。

## 4. 技术选型

| 层 | 技术 | 理由 |
|---|---|---|
| 前端 | Swiper.js + Animate.css（+ SheetJS 仅用于导入时解析） | 交互方案保持不变 |
| 后端 | Node.js + Express | 与前端同语言，零基础友好 |
| 数据库 | SQLite（`better-sqlite3`） | 零配置、单文件、几百人规模足够 |
| Excel 解析 | SheetJS（`xlsx` 0.20.3） | 仅服务端导入脚本使用；npm 上的 0.18.5 有原型污染漏洞，官方 CDN 版已随仓库放在 `vendor/` |
| Session | `express-session` + 自写 better-sqlite3 Store | Session 落库、重启不丢失；不用 `connect-sqlite3`，它依赖 `sqlite3` 原生模块，其预编译包在本机网络下拉不到 |
| 密码 | `bcryptjs` 哈希 | 纯 JS 实现，无需编译，不存明文 |
| 反向代理 | Nginx | HTTPS、静态文件、转发 `/api` |
| 容器编排 | Docker + docker-compose | 环境一致、隔离、一条命令部署 |
| HTTPS | Let's Encrypt（Certbot） | 免费证书 |

Docker 环境下**不使用 PM2**：容器守护与开机自启由 `restart: unless-stopped` 接管；若需多核再改用 `pm2-runtime`。

## 5. 数据模型

```sql
CREATE TABLE students (
  student_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT,
  join_days INTEGER,
  volunteer_hours REAL,
  activity_count INTEGER,
  partner TEXT,
  message TEXT,
  password_hash TEXT NOT NULL
);

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT,
  expire INTEGER
);
```

## 6. API 设计

| 接口 | 方法 | 功能 |
|---|---|---|
| `/api/login` | POST | 校验学号密码，创建 Session |
| `/api/report` | GET | 返回当前登录学员的报告数据（需 Session） |
| `/api/logout` | POST | 销毁 Session |
| `/api/password` | POST | 学员自助改密码：校验当前密码，改完让其他设备的会话失效 |
| `/api/admin/*` | 见 §14 | 管理控制台的全部接口（需管理员会话） |

关键约束：

- 登录校验用 `bcrypt.compare`，`/api/report` 必须先检查 `req.session.studentId`
- 前端所有请求带 `credentials: 'include'` 以携带 HttpOnly Cookie
- Excel 导入路径：SheetJS 解析 → bcrypt 哈希密码 → `INSERT OR REPLACE` 写库，从而保留「只维护一个 Excel」的习惯

已实现的行为约定（`server.js`）：

- 未登录访问受保护接口 → `401 {"error":"未登录"}`
- 登录失败统一 `401 {"error":"学号或密码错误"}`，不区分「学号不存在」与「密码错误」；参数缺失 → `400`
- 未知 `/api/*` 路径 → `404 {"error":"接口不存在"}`（JSON，不会回落到首页）
- 登录成功后 `session.regenerate()` 防会话固定攻击；Session 存进 SQLite，重启容器仍有效
- `/api/report` 返回 camelCase 字段：`name`、`department`、`joinDays`、`volunteerHours`、`activityCount`、`partner`、`message`
- `/api/report` 还会返回 `backgrounds`（**文件名去掉扩展名 → URL** 的映射，只含磁盘上真实存在的图）和 `music`（音频 URL 或 `null`）。后端只读挂载了 `static/`，直接查文件是否存在，前端因此不需要试探、也不会产生 404
- 防暴力破解：同学号连续失败 5 次锁 10 分钟；同 IP 失败 30 次锁 10 分钟（校园网共用出口，故意放宽）。命中后返回 `429 错误次数过多，请 X 分钟后再试`；计数在进程内存里（`rate-limit.js`），重启容器即清空
- 改密码接口：要求当前密码正确、新密码 6–64 位且与旧密码不同；成功后删除该学员除当前设备外的所有会话

## 7. 前端实现要点（已实现，`static/`）

页面：1 个登录页（独立于 Swiper，页面底部提示「初始密码为学号后六位」）+ 7 屏报告页（开场 → 加入天数 → 志愿时长 → 活动次数 → 年度伙伴 → 部长寄语 → 结尾）+ 1 个修改密码页（从结尾页的按钮进入）。文件为 `index.html` / `style.css` / `app.js`，第三方库放 `static/vendor/`（Swiper 11.2.10、Animate.css 4.1.1，已本地化，不从 CDN 引）。管理控制台是三份独立文件 `admin.html` / `admin.js` / `admin.css`，入口 `/admin.html`（见 §14）。

- Swiper 垂直翻页：`direction: 'vertical'`、`speed: 800`（网易云式阻尼感约 700–900）、`mousewheel: true`、`pagination.clickable`，在 `slideChangeTransitionStart` 里触发当前屏动画
- **没用 `swiper.animate` 插件**（它是 Swiper 3/4 时代产物，与现代版本兼容性没保证），改为自实现：元素写 `data-animate="fadeInUp"`（可加 `data-delay` / `data-duration`），进入该屏时先移除再挂上 `animate__animated animate__<效果>`，配合 `void offsetWidth` 强制重排，实现「再次进入重新播放」
- 大数字滚动：标 `data-count="字段名"`，进入该屏时用 `requestAnimationFrame` 从 0 滚到目标值（整数 0 位小数、REAL 1 位）
- 数据填充：标 `data-field="字段名"`，用 `textContent` 写入（不用 innerHTML，避免 XSS）；寄语用 `white-space: pre-wrap` 保留换行
- 背景图：每屏写 `data-bg="01-opening"`（不带扩展名），JS 用后端返回的 `backgrounds` 映射直接设置；没配图的页面保留页面自带的深色渐变，有图时自动加 45% 暗层保证文字可读
  - 查找顺序：`static/images/<背景图目录>/`（目录留空时用学号）优先，其次共享的 `static/images/`
  - 约定的键名：`01-opening`、`02-days`、`03-hours`、`04-activities`、`05-partner`、`06-message`、`07-ending`；扩展名不限（jpg/jpeg/png/webp），同名有多个格式时按 **jpg → jpeg → png → webp** 取第一个
  - 建议 750×1334 或 1080×1920，单图压到 200KB 以内、7 张总量 2MB 以内；`static/images/`、`static/music/` 都不入库
- 背景音乐：后端返回 `music` URL 时，报告页右上角出现圆形开关按钮（播放态有呼吸动画，暂停态画一道斜杠）
  - 登录后自动尝试播放；被浏览器自动播放策略拦下时按钮显示为暂停态，等用户点一下
  - 开关选择记在 `localStorage`（键 `report.bgm`），主动关过就不再自动响；退出登录会停止播放
  - 文件查找：优先 Excel 的「背景音乐」列（写全名最优先，只写基名则按格式优先级），留空时找与学号同名的音频；支持的格式按 **mp3 → m4a → ogg → wav** 排序取第一个
- Session 过期或未登录时 `/api/report` 返回 401，前端自动停在登录页；登录失败/网络异常都在表单里显示提示，不用 alert

## 8. 部署与运维

**Dockerfile 要点**：`node:24-alpine`（Node 20 已 EOL，且 better-sqlite3 13 要求 Node ≥ 22）→ 多阶段构建：builder 阶段 `npm ci --omit=dev --ignore-scripts`，运行阶段只拷贝 `node_modules` 与代码 → `EXPOSE 3000` → `CMD ["node", "server.js"]`

**docker-compose 要点**：

- `app` 服务不映射端口到宿主机，仅由 Nginx 经内部网络转发（更安全）；数据库卷 `sqlite_data` → `/app/data`（`DB_PATH=/app/data/report.db`），`./import` → `/app/import` 供导入脚本读 Excel，`./static` → `/app/static`（**可写**：管理面板要上传图片/音乐，nginx 侧仍是只读）
- 上传的文件属主是 root（app 容器以 root 运行）。宿主机上的 debian 用户想原地覆盖这些文件会 EACCES，需要先删或 `mv`，也可以 `sudo chown -R debian:debian static/images static/music`
- `nginx` 服务映射 `${HTTP_PORT}:80`，挂载 `nginx/default.conf` 与 `./static`（`ro`），`depends_on` app 的健康检查
- 服务间通过自定义 bridge 网络 `report-network` 通信，Nginx 中 `proxy_pass http://app:3000`
- `app.build.network: host`：容器默认 bridge 网络没有 IPv6 路由，构建期借用宿主机网络（原因见 §11）

**nginx 配置要点**（`nginx/default.conf`）：静态托管 + `/api/` 反代（`proxy_read_timeout 300s`，批量导入逐行算 bcrypt 可能超过默认 60s）+ `/images/`、`/music/` 不存在时直接 404 并带 `X-Content-Type-Options: nosniff`；已启用 gzip（`comp_level 2`、`min_length 1024`，只压文本类，图片与 `/api/` 显式 `gzip off`）—— 文本资源首访从 266KB 降到约 64KB；`/admin` 302 到 `/admin.html`，面板三个文件加 `Cache-Control: no-cache`（避免部署后加载旧 JS）

**常用运维命令**

| 任务 | 命令 |
|---|---|
| 部署/更新代码 | `docker compose up -d --build` |
| 仅更新前端静态文件 | `docker compose restart nginx` |
| 查看日志 | `docker compose logs -f app`（或 `nginx`） |
| 备份数据库 | `docker run --rm -v sqlite_data:/data -v $(pwd):/backup alpine tar cvf /backup/backup.tar /data` |

## 9. 开发路径（约 3–4 周）

1. ~~**服务器初始化**~~（已完成）：Docker 与 Compose 就位，系统 nginx 已停用，对外 80 端口由 `report-nginx` 接管
2. ~~**后端 API**~~（已完成）：建库建表、登录/报告/登出接口、Excel 导入脚本，详见 §12
3. ~~**前端对接 API**~~（已完成）：登录页 + 7 屏报告页，实现细节见 §7
4. **部署与 HTTPS**：Nginx 反代已就位，待域名与 Certbot 证书
5. **测试与交付**

**测试清单**：错误学号/密码有提示；未登录访问 `/api/report` 被拒；Session 过期跳回登录页；手机端滑动与动画正常；导入 Excel 后数据正确更新；HTTPS 无浏览器安全警告。

## 10. 每学年维护流程

1. 本地准备新 Excel（含全部字段与初始密码），或先用 `--template` 生成模板
2. 放进 `import/` 目录后执行 `docker compose exec app node scripts/import-excel.js import/你的文件.xlsx`（SheetJS 解析 → bcrypt 哈希 → 按学号 upsert）
3. 替换背景图（放在 `static/`），必要时更新页面文案配置
4. 前端代码与后端代码均无需改动

## 11. 本机部署现状（实测记录）

**运行环境**：Debian 13，Docker 29.7.2 + Compose v5.5.0（当前用户在 docker 组，`sudo` 需要密码）。系统 nginx 曾占用 80 端口提供默认站点，已 `stop` + `disable`；另有 frpc 内网穿透容器（只映射了 terraria 的 7777）。内网地址 `10.129.246.40`。

**当前形态**：compose 编排 `report-app`（Node 24，容器内 3000，不对外映射端口）+ `report-nginx`（映射 `${HTTP_PORT}:80`）。`.env` 已设 `HTTP_PORT=80`，站点地址 `http://10.129.246.40/`。

**实测确认的限制与结论**：

- Docker Hub 直连不可达（`registry-1.docker.io` 超时），`docker.m.daocloud.io`、`docker.1ms.run` 可用。拉镜像时 `docker pull docker.m.daocloud.io/library/<image>` 再 `docker tag` 回标准名，compose 里保持标准镜像名保证可移植。
- npm 走 `registry.npmmirror.com`，`package-lock.json` 里的 `resolved` 已是镜像地址。
- better-sqlite3 v13 的 npm 包自带 `prebuilds/linuxmusl-x64.node` 等各平台预编译二进制，**无需 python3/make/g++ 编译**；Dockerfile 中 `npm ci` 加 `--ignore-scripts`（npm 11 默认也会拦截依赖的 install 脚本）。构建耗时约 10 秒，带编译工具链的方案则要 5 分钟以上。
- 未登录状态访问 `/api/xxx` 会由 Express 返回 404，不会回落到 `index.html`（`try_files` 只作用于非 `/api/` 路径）。
- 容器默认 bridge 网络**没有 IPv6 路由**，而镜像源会返回 AAAA 记录 → 容器内 `npm ci`、下载文件会长时间卡死挂起（宿主机网络正常，同一地址 0.2 秒返回）。解决：compose 里 `app.build.network: host`，仅影响构建期；运行期的 app 不需要外网。
- SheetJS 官方 CDN 在宿主机 0.8 秒下完（2.4MB），在容器里却卡住 → 已把 `xlsx-0.20.3.tgz` 放进 `vendor/` 并用 `file:` 依赖，构建不再依赖外部 CDN。
- **frpc 隧道当前不通**：日志为 `dial tcp 140.143.226.163:7000: i/o timeout`，容器在反复重启，公网入口不可用。与本项目无关，但会影响后续对外访问与 HTTPS 申请。

**常用命令**（项目根目录执行）：

| 任务 | 命令 |
|---|---|
| 构建并启动 | `docker compose up -d --build` |
| 查看状态 | `docker compose ps` |
| 应用日志 | `docker compose logs -f app` |
| 停止（保留数据） | `docker compose down` |
| 只改前端静态文件 | 直接改 `static/` 内容，无需重启容器 |
| 改了 nginx 配置 | `docker compose exec nginx nginx -s reload`（配置以目录形式挂载，改完 reload 即生效；若改了挂载本身才需要 `docker compose up -d nginx`） |
| 重新构建镜像 | `docker compose up -d --build`（构建走宿主机网络，约十几秒） |

**文件对应关系**：`docker-compose.yml`（服务编排）→ `nginx/default.conf`（以目录形式挂载为 `/etc/nginx/conf.d`）→ `static/`（挂载为 `/usr/share/nginx/html`，含登录页与报告页、`vendor/` 本地化前端库、`images/` 背景图、`music/` 背景音乐）→ `server.js`（app 入口）+ `db.js`（建库建表）+ `session-store.js`（会话存储）+ `rate-limit.js`（登录失败限流）+ `scripts/import-excel.js`（Excel 导入）。

## 12. 后端现状与 Excel 导入

已实现：`db.js`（SQLite 建库建表）、`session-store.js`（better-sqlite3 会话存储）、`rate-limit.js`（登录失败限流）、`server.js`（`/api/health`、`/api/login`、`/api/password`、`/api/report`、`/api/logout`）、`scripts/import-excel.js`（导入脚本）。另有 `scripts/make-test-tone.js`：生成一段 8 秒测试音乐（`node scripts/make-test-tone.js`，默认写 `static/music/2021001.wav`），用于验证播放链路。

**导入数据步骤**（每学年维护时执行，均在项目根目录）：

```bash
# 1. 生成模板 → import/students-template.xlsx
docker compose exec app node scripts/import-excel.js --template

# 2. 按模板填好数据放进 import/ 目录，再导入
docker compose exec app node scripts/import-excel.js import/学员数据.xlsx
```

表头（中文，第一行）：`学号、密码、姓名、部门、加入天数、志愿时长、活动次数、年度伙伴、部长寄语、背景图目录、背景音乐`（最后两列可选）。

导入规则：按学号 upsert（`INSERT ... ON CONFLICT DO UPDATE`）。密码列的三种情况：

- 填了值 → 用该值（重新哈希），可用于重置某人的密码
- 留空且该学员已存在 → 保留库里的原密码（适合只改其他字段）
- 留空且是新学员 → **用「学号后六位」作初始密码**（如 2021003 → `021003`），导入结束会提示有多少人用了初始密码

运行结束会打印「成功 N 条，跳过 M 条」。

**学员专属的背景图与背景音乐**（都以 Excel 为准，重新导入时留空即回到默认）：

- 「背景图目录」留空 → 自动用 `static/images/<学号>/`；填了值就用 `static/images/<该值>/`
- 「背景音乐」留空 → 自动找 `static/music/<学号>.mp3`（或 .m4a/.ogg/.wav，优先级见 §7）；填了值就用文件里已存在的那个（可多人共用同一首）
- 文件只需丢进对应目录，**不用改代码、也不用重启容器**：后端每次请求实时查文件

**库内有 3 个测试账号**：2021001 张三、2021002 李四（密码 `init123456`），2021003 王五（密码是学号后六位 `021003`，用于验证「初始密码」链路）。导入真实数据后可清理：

```bash
docker compose exec app node -e "const db=require('./db');db.prepare('delete from students where student_id in (?,?,?)').run('2021001','2021002','2021003');console.log(db.prepare('select count(*) c from students').get())"
```

（`docker compose down -v` 会连数据卷一起清空，慎用。）

## 13. 待确认事项

- 域名与 HTTPS 证书是否已备好
- 学员规模（决定 SQLite 是否长期够用）
- 管理后台：**已实现网页控制台**（`/admin.html`，见 §14），命令行导入脚本保留作为批量维护手段
- 服务器发行版已确认：本机即 Debian 13，Docker 与 Compose 均已装好
- HTTPS：需要域名解析到公网入口（当前公网入口是 frps，需在 frpc.toml 增加 80/443 的 tcp 代理）
- 密码策略已定：初始密码 = 学号后六位（见 §12），登录页有对应提示；如需更复杂的初始密码规则可再调整
- 背景图：尚未提供，当前用每屏自带渐变占位；放好图后放进 `static/images/` 即可自动生效（文件名约定见 §7）

## 14. 管理控制台（`/admin.html`）

管理员账号用 CLI 创建，密码只以 bcrypt 哈希入库、不进任何配置文件：

```bash
# 创建/改密（推荐：密码从标准输入读，不落 shell 历史）
printf '你的密码\n' | docker compose exec -T app node scripts/set-admin.js admin
docker compose exec -T app node scripts/set-admin.js admin '直接在命令里写密码'
docker compose exec -T app node scripts/set-admin.js --list        # 列出所有管理员
docker compose exec -T app node scripts/set-admin.js admin --delete # 删除
```

用户名限字母/数字/下划线/点/短横线（1–32 位），密码 8–64 位；改密或删号会立刻注销该管理员的已登录会话。

**面板功能**：成员列表搜索/编辑/删除、**勾选成员批量操作**（全选、跨搜索保留选择，可批量改某个字段、把密码重置为学号后六位、**批量媒体操作**、批量删除）、单条新增、粘贴文本批量添加（每行一名学员，字段顺序同 Excel，逗号或 Tab 分隔，字段内含逗号用双引号包裹，一行即单条、多行即多条）、Excel 导入（预览 → 确认）、Excel 导出、背景图与背景音乐的上传/替换/删除/指派、**媒体文件批量上传**（见下方命名规则）。所有写操作都先预览或二次确认。

**批量媒体操作**（勾选成员后点「批量媒体」）：指派背景音乐（或清空回到「与学号同名」）、设置背景图目录（留空=回到学号目录）、把同一张图上传进每名学员各自实际使用的图目录、删除这些学员在某槽位的专属图（回落到共享图）。上传与删除会逐个学员顺序执行并显示进度，没有专属图的学员自动跳过。

**媒体批量上传的命名规则**（在媒体页选多个文件或整个文件夹，上传前会先列出每份文件的归属清单）：

| 文件名 / 目录结构 | 归属 | 落到磁盘 |
|---|---|---|
| `01-opening.jpg` | 所有学员的共享图 | `images/01-opening.jpg` |
| `2021001-01-opening.jpg` 或 `2021001_01-opening.jpg` | 该学员的专属图 | `images/2021001/01-opening.jpg` |
| 文件夹里的 `2021001/01-opening.jpg`（学号作为子目录名） | 该学员的专属图 | `images/2021001/01-opening.jpg` |
| `2021001.mp3` | 该学员的背景音乐（与学号同名，自动生效） | `music/2021001.mp3` |

无法识别归属的文件、学号不在成员表里的文件、超过大小上限的文件都会在上传前标红拦下；同名文件默认跳过（可勾选「直接覆盖」）。批量上传本身不修改数据库，只负责把文件放到正确位置 —— 音乐与专属图都靠既有的命名约定自动生效。

**接口一览**（全部在 `/api/admin` 下，未登录统一 `401 {"error":"管理员未登录"}`）：

| 方法 路径 | 作用 |
|---|---|
| `POST /login`、`POST /logout`、`GET /session` | 登录（独立限流：用户名 5 次/15 分钟、IP 10 次/15 分钟）、退出、查登录态 |
| `GET /meta` | 下发中文表头、7 个图片槽位、大小上限、扩展名白名单、`media.writable`（诊断挂载是否可写） |
| `GET /students?q=&limit=` | 成员列表（不含 password_hash），搜索用 `instr()` |
| `POST /students` / `PUT /students/:studentId` / `DELETE /students/:studentId` | 新增 / 局部更新（只改提交的字段；`password` 缺省=不改，改了会踢掉该学员其他设备）/ 删除（并清其会话） |
| `POST /students/batch` | 批量修改：`set` 指定要改的字段（限部门/加入天数/志愿时长/活动次数/年度伙伴/部长寄语/背景图目录/背景音乐），或 `resetPasswordToDefault:true` 把密码批量重置为「学号后六位」；一次最多 500 人，重置密码会注销这些学员的会话 |
| `POST /students/batch-delete` | 批量删除（连带清会话） |
| `GET /students/:studentId/report` | 预览该学员会看到的报告与资源解析结果（排查图片/音乐是否配对） |
| `POST /import/text/preview`、`POST /import/text` | 文本批量：预览 / 执行（幂等，重复提交无害） |
| `POST /import/xlsx/preview`、`POST /import/xlsx` | Excel 批量：预览 / 执行（原始字节 + `X-File-Name` 头，不使用 multipart） |
| `GET /export/xlsx`、`GET /export/template.xlsx` | 导出名单（密码列必然为空）/ 下载导入模板 |
| `GET /media` | 媒体全景：共享图、各学员专属图、音乐，含「谁在用」与「未生效的同名文件」 |
| `POST /media/upload?kind=&dir=&name=&overwrite=` | 上传/替换（`dir` 为空=共享图，非空=写入该学员目录并自动建目录） |
| `DELETE /media?kind=&dir=&name=` | 删除文件（顺带回收空目录） |

**实现要点（改动时请保持这些约束）**：

- 成员数据规则只有一处：`lib/student-records.js` 被 CLI 与面板共用 —— Excel 导入、文本批量、单条新增/编辑用同一套校验与密码三规则，不要另写一套
- 同名文件默认 409，需带 `overwrite=1` 才覆盖；同基名下优先级更高的格式会遮蔽新文件，上传响应里的 `shadows` 会明确指出是哪个文件
- 上传安全：扩展名白名单 + 可疑字符拦截 + `path.resolve` 前缀断言（Express 5 会解码路由参数，`%2F` 会变成 `/`）；写盘用「临时文件 + rename」，避免 nginx 读到半个文件
- 资源 URL 一律带 `?v=<mtime>-<size>`：`/images/`、`/music/` 的浏览器缓存是 30 天，不带版本号时换了图也不会刷新
- 批量导入是「先异步算 bcrypt，再单事务写入」两阶段：几百名新学员同步哈希会阻塞事件循环几十秒，期间全站卡顿、健康检查可能判死
- 管理接口挂在全局 `express.json()` **之前**且自带 2MB 上限（全局默认仅 100kb，几百人的批量文本会被 413）
- 管理员与学员共用同一个会话 cookie：`POST /api/admin/logout` 只退管理面板；学员端的 `POST /api/logout` 会销毁整个会话（连管理面板一起退）
- 批量媒体操作不需要新接口：指派音乐/目录走 `POST /students/batch`，上传/删除走既有的媒体接口，前端逐个学员顺序执行；上传时必须写进该学员**实际读取的目录**（显式指定过 `bgDir` 时不是学号目录）
