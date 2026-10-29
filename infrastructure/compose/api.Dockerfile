FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache openssl libc6-compat \
  && corepack enable

# Install from the complete workspace so pnpm creates all package-level
# dependency links correctly. Splitting manifest and source copies causes
# stale links in Docker layers and breaks the API image at compile time.
COPY . .
RUN pnpm install --frozen-lockfile=false --prod=false
# 接口服务依赖的全部工作区包（顺序无关，彼此不互相依赖构建产物）：契约、权限、指标、租户隔离、流程与可靠性、文件存储、应用层加密。
RUN pnpm --filter @nova/api-contracts build \
  && pnpm --filter @nova/authz build \
  && pnpm --filter @nova/metrics build \
  && pnpm --filter @nova/tenancy build \
  && pnpm --filter @nova/workflow build \
  && pnpm --filter @nova/storage build \
  && pnpm --filter @nova/crypto build \
  && pnpm --filter @nova/api prisma:generate \
  && pnpm --filter @nova/api build
# 文件存储目录（本地驱动）：生产必须挂载为持久卷，并与后台任务共享、纳入备份
RUN mkdir -p /data/storage
EXPOSE 4000
# 堆上限与容器内存限制匹配：接口进程不设上限会一直长到被系统强杀。
ARG NODE_MAX_OLD_SPACE_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}"
CMD ["node","apps/api/dist/main.js"]
