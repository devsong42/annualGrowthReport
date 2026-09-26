# 构建阶段：安装依赖
FROM node:24-alpine AS builder

WORKDIR /app

# better-sqlite3 v13 的 npm 包自带各平台预编译二进制（含 musl），无需本地编译
RUN npm config set registry https://registry.npmmirror.com

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# 运行阶段：只保留依赖与代码，不含 npm 缓存
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
