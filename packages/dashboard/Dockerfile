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
COPY packages/dashboard packages/dashboard

# NEXT_PUBLIC_SERVER_URL is baked in at build time (used by the browser SSE hook)
ARG NEXT_PUBLIC_SERVER_URL=http://localhost:4000
ENV NEXT_PUBLIC_SERVER_URL=${NEXT_PUBLIC_SERVER_URL}
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @integration-stepper/dashboard build && \
    pnpm --filter @integration-stepper/dashboard deploy --prod /deploy

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /deploy ./
COPY --from=builder /app/packages/dashboard/.next ./.next

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["./node_modules/.bin/next", "start"]
