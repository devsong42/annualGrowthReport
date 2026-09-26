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
| `/api/admin/import` | POST | （可选）管理员上传 Excel 批量导入 |

关键约束：

- 登录校验用 `bcrypt.compare`，`/api/report` 必须先检查 `req.session.studentId`
- 前端所有请求带 `credentials: 'include'` 以携带 HttpOnly Cookie
- Excel 导入路径：SheetJS 解析 → bcrypt 哈希密码 → `INSERT OR REPLACE` 写库，从而保留「只维护一个 Excel」的习惯

## 7. 前端实现要点

- Swiper 垂直翻页配置：`direction: 'vertical'`、`speed: 800`（网易云式阻尼感约 700–900）、`mousewheel: true`、`pagination.clickable`
- 动画用 `swiper.animate` 插件，走 `swiper-animate-effect` / `swiper-animate-duration` / `swiper-animate-delay` 属性，翻页进出自动触发与重置（比手动加删 class 更省事）
- 页面动画触发点：Swiper 的 `slideChangeTransitionStart` 回调
- 登录成功后 `fetch('/api/report')` 拿数据，用 JS 写入各页占位元素
- 大数字滚动效果（0 滚到目标值）用 `requestAnimationFrame` 实现
- 背景图尺寸建议 750×1334 或 1080×1920；单图压缩到 200KB 以内，8 张图总量控制 2MB 以内

## 8. 部署与运维

**Dockerfile 要点**：`node:24-alpine`（Node 20 已 EOL，且 better-sqlite3 13 要求 Node ≥ 22）→ 多阶段构建：builder 阶段 `npm ci --omit=dev --ignore-scripts`，运行阶段只拷贝 `node_modules` 与代码 → `EXPOSE 3000` → `CMD ["node", "server.js"]`

**docker-compose 要点**：

- `app` 服务不映射端口到宿主机，仅由 Nginx 经内部网络转发（更安全）
- `nginx` 服务映射 `80:80`、`443:443`，挂载 `./nginx.conf` 与 `./static`（`ro`），`depends_on: app`
- 数据持久化：`sqlite_data` 卷挂载到 `/app/data`，`DB_PATH=/app/data/report.db`
- 服务间通过自定义 bridge 网络 `report-network` 通信，Nginx 中 `proxy_pass http://app:3000`

**常用运维命令**

| 任务 | 命令 |
|---|---|
| 部署/更新代码 | `docker compose up -d --build` |
| 仅更新前端静态文件 | `docker compose restart nginx` |
| 查看日志 | `docker compose logs -f app`（或 `nginx`） |
| 备份数据库 | `docker run --rm -v sqlite_data:/data -v $(pwd):/backup alpine tar cvf /backup/backup.tar /data` |

## 9. 开发路径（约 3–4 周）

1. **服务器初始化**（1–2 天）：安装 Docker（官方仓库方式）、开放 22/80/443
2. **后端 API**（3–5 天）：建库建表、登录/报告/登出接口、Excel 导入脚本
3. **前端对接 API**（2–3 天）：登录改调 `/api/login`，报告数据改取 `/api/report`（Swiper 与动画代码不用改）
4. **部署与 HTTPS**（1–2 天）：Nginx 反代、Certbot 证书
5. **测试与交付**（2–3 天）

**测试清单**：错误学号/密码有提示；未登录访问 `/api/report` 被拒；Session 过期跳回登录页；手机端滑动与动画正常；导入 Excel 后数据正确更新；HTTPS 无浏览器安全警告。

## 10. 每学年维护流程

1. 本地准备新 Excel（含全部字段与初始密码）
2. 上传导入：SheetJS 解析 → bcrypt 哈希 → `INSERT OR REPLACE`
3. 替换背景图（放在静态目录），必要时更新页面文案配置
4. 前端代码与后端代码均无需改动

## 11. 本机部署现状（实测记录）

**运行环境**：Debian 13，Docker 29.7.2 + Compose v5.5.0（当前用户在 docker 组，`sudo` 需要密码）。系统 nginx 已安装且在 80 端口跑默认站点；另有 frpc 内网穿透容器（目前只映射了 terraria 的 7777）。内网地址 `10.129.246.40`。

**当前形态**：compose 编排 `report-app`（Node 24，容器内 3000，不对外映射端口）+ `report-nginx`（映射 `${HTTP_PORT}:80`）。由于系统 nginx 占着 80，`.env` 暂设 `HTTP_PORT=8080`，内网访问 `http://10.129.246.40:8080`；停用系统 nginx 后改成 80 即可。

**实测确认的限制与结论**：

- Docker Hub 直连不可达（`registry-1.docker.io` 超时），`docker.m.daocloud.io`、`docker.1ms.run` 可用。拉镜像时 `docker pull docker.m.daocloud.io/library/<image>` 再 `docker tag` 回标准名，compose 里保持标准镜像名保证可移植。
- npm 走 `registry.npmmirror.com`，`package-lock.json` 里的 `resolved` 已是镜像地址。
- better-sqlite3 v13 的 npm 包自带 `prebuilds/linuxmusl-x64.node` 等各平台预编译二进制，**无需 python3/make/g++ 编译**；Dockerfile 中 `npm ci` 加 `--ignore-scripts`（npm 11 默认也会拦截依赖的 install 脚本）。构建耗时约 10 秒，带编译工具链的方案则要 5 分钟以上。
- 未登录状态访问 `/api/xxx` 会由 Express 返回 404，不会回落到 `index.html`（`try_files` 只作用于非 `/api/` 路径）。

**常用命令**（项目根目录执行）：

| 任务 | 命令 |
|---|---|
| 构建并启动 | `docker compose up -d --build` |
| 查看状态 | `docker compose ps` |
| 应用日志 | `docker compose logs -f app` |
| 停止（保留数据） | `docker compose down` |
| 只改前端静态文件 | 直接改 `static/` 内容，无需重启容器 |

**文件对应关系**：`docker-compose.yml`（服务编排）→ `nginx/default.conf`（挂载为 `/etc/nginx/conf.d/default.conf`）→ `static/`（挂载为 `/usr/share/nginx/html`，当前只有部署自检占位页）→ `server.js`（app 容器入口，当前仅 `/api/health`）。

## 12. 待确认事项

- 域名与 HTTPS 证书是否已备好
- 学员规模（决定 SQLite 是否长期够用）
- 是否需要管理后台，还是先用命令行导入脚本
- 服务器发行版已确认：本机即 Debian 13，Docker 与 Compose 均已装好
- HTTPS：需要域名解析到公网入口（当前公网入口是 frps，需在 frpc.toml 增加 80/443 的 tcp 代理）
- 密码策略：初始密码规则如何设定
