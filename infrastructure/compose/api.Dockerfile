FROM node:22-alpine
WORKDIR /workspace
RUN apk add --no-cache openssl libc6-compat \
  && corepack enable

# Install from the complete workspace so pnpm creates all package-level
# dependency links correctly. Splitting manifest and source copies causes
# stale links in Docker layers and breaks the API image at compile time.
COPY . .
RUN pnpm install --frozen-lockfile=false --prod=false
RUN pnpm --filter @nova/api-contracts build \
  && pnpm --filter @nova/authz build \
  && pnpm --filter @nova/metrics build \
  && pnpm --filter @nova/api prisma:generate \
  && pnpm --filter @nova/api build
EXPOSE 4000
CMD ["node","apps/api/dist/main.js"]
