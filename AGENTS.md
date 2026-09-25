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
| Session | `express-session` + `connect-sqlite3` | Session 落库，重启不丢失 |
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

**Dockerfile 要点**：`node:20-alpine` 基础镜像 → `WORKDIR /app` → 先 `COPY package*.json` 再 `RUN npm install --production`（利用缓存层）→ `COPY . .` → `EXPOSE 3000` → `CMD ["node", "server.js"]`

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

## 11. 待确认事项

- 域名与 HTTPS 证书是否已备好
- 学员规模（决定 SQLite 是否长期够用）
- 是否需要管理后台，还是先用命令行导入脚本
- 服务器发行版：安装 Docker 的命令按 Ubuntu 编写，若为 Debian 需调整仓库地址（当前环境为 Debian 13）
- 密码策略：初始密码规则如何设定
