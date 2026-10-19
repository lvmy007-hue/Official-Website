FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache openssl libc6-compat \
  && corepack enable

# Keep the worker on the same complete workspace install as the API so its
# Prisma, BullMQ and TypeScript links are reproducible in CI and on Aliyun.
COPY . .
RUN pnpm install --frozen-lockfile=false --prod=false
RUN pnpm --filter @nova/api prisma:generate \
  && pnpm --filter @nova/worker build
CMD ["node","apps/worker/dist/main.js"]
