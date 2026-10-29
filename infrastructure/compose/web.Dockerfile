FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml turbo.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/authz/package.json packages/authz/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/tenancy/package.json packages/tenancy/package.json
COPY packages/workflow/package.json packages/workflow/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/crypto/package.json packages/crypto/package.json
RUN pnpm install --frozen-lockfile=false
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json eslint.config.mjs ./
# 前端通过别名直接引用共享契约与权限包的源码（vite.config.ts、tsconfig.app.json），构建需要这两个包的源码
COPY packages/api-contracts/src packages/api-contracts/src
COPY packages/authz/src packages/authz/src
COPY src src
COPY public public
COPY scripts scripts
ARG VITE_API_MODE=server
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_MODE=${VITE_API_MODE}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm build
FROM nginx:1.27-alpine
COPY infrastructure/aliyun/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -q -O - http://127.0.0.1/health | grep -q '^ok$' || exit 1
