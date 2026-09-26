# 构建阶段：安装依赖
FROM node:24-alpine AS builder

WORKDIR /app

# better-sqlite3 v13 的 npm 包自带各平台预编译二进制（含 musl），无需本地编译
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
# SheetJS 官方包从 npm 装不到（npm 上只有有漏洞的 0.18.5），官方 CDN 在国内容器里极慢，故随仓库携带
COPY vendor ./vendor
RUN npm ci --omit=dev --ignore-scripts

# 运行阶段：只保留依赖与代码，不含 npm 缓存
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY . ./

EXPOSE 3000
CMD ["node", "server.js"]
