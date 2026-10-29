FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache openssl libc6-compat \
  && corepack enable

# Keep the worker on the same complete workspace install as the API so its
# Prisma, BullMQ and TypeScript links are reproducible in CI and on Aliyun.
COPY . .
RUN pnpm install --frozen-lockfile=false --prod=false
# 后台任务依赖的工作区包：租户隔离、流程与可靠性、文件存储、应用层加密（接口契约与权限包被它们间接引用，一并构建）
RUN pnpm --filter @nova/api-contracts build \
  && pnpm --filter @nova/authz build \
  && pnpm --filter @nova/tenancy build \
  && pnpm --filter @nova/workflow build \
  && pnpm --filter @nova/storage build \
  && pnpm --filter @nova/crypto build \
  && pnpm --filter @nova/api prisma:generate \
  && pnpm --filter @nova/worker build
RUN mkdir -p /data/storage
# 堆上限必须与容器内存限制匹配（留出非堆内存余量）：不设上限时 Node 会一直长到被系统强杀，在途任务随之丢失。
# 进程内存守卫（WORKER_RSS_LIMIT_MB、WORKER_HEAP_RATIO）在到达上限之前就会优雅退出，由容器的重启策略拉起新进程。
ARG NODE_MAX_OLD_SPACE_MB=1536
ENV NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}"
CMD ["node","apps/worker/dist/main.js"]
