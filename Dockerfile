# 多阶段构建。运行时只需要 express + 构建产物 + 数据快照。
#
# 数据快照是**烤进镜像**的，不挂卷：这个部署是作品展示，要的是几年后打开
# 还长一个样。数据要更新就重新构建镜像（见 deploy/README.md）。

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 挂在 ai.tzspace.cn/works/dc-nba/ 下，构建产物里的资源路径必须带这个前缀，
# 否则页面会去请求 /assets/xxx.js 而不是 /works/dc-nba/assets/xxx.js —— 白屏。
# 本地开发不传这个变量，base 退回 "/"，不受影响。
ARG APP_BASE=/
ENV APP_BASE=$APP_BASE
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# 公网暴露时必须关掉 POST /api/refresh —— 它无鉴权且会 spawn 抓取进程
ENV ALLOW_REFRESH=0

RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001 -G nodejs

# 只装生产依赖（就一个 express），devDependencies 里的 vite/react 不进运行镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=app:nodejs server ./server
COPY --chown=app:nodejs data ./data
# 只拷备份脚本，不拷 scripts/ 整个目录 —— ingest.mjs 是抓取脚本，
# 运行镜像里不该有它（/api/refresh 已经关了，抓取只在构建数据快照时做）。
# backup-db.mjs 只依赖 node 内置模块，单独拷进来即可 docker exec 调用：
#   docker exec dc-nba node scripts/backup-db.mjs
COPY --chown=app:nodejs scripts/backup-db.mjs ./scripts/backup-db.mjs
# 模拟投注账本：deploy/refresh.sh 在容器健康后 docker exec 调它写 data-db/ 里的库
COPY --chown=app:nodejs scripts/ledger.mjs ./scripts/ledger.mjs
COPY --from=builder --chown=app:nodejs /app/web/dist ./web/dist

USER app
EXPOSE 3000
# 启动时会 loadStore()，数据缺失会直接 exit(1)，所以健康检查探到端口就说明数据也在
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/meta >/dev/null || exit 1

CMD ["node", "server/index.mjs"]
