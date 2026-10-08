FROM node:22-alpine AS builder
RUN corepack enable pnpm
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/server packages/server

RUN pnpm --filter @integration-stepper/core build && \
    pnpm --filter @integration-stepper/server build && \
    pnpm --filter @integration-stepper/server deploy --prod /deploy

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /deploy ./
EXPOSE 4000
CMD ["node", "dist/bin.js"]
