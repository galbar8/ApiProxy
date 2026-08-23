# Build stage runs natively on whatever the builder is; the output is plain JavaScript,
# so nothing here is architecture-specific.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Runtime stage is pinned to the architecture the ECS task definition requests. Without
# this pin an image built on an x86 laptop is accepted by ECR and then fails to start with
# a manifest mismatch that only surfaces at deploy time.
FROM --platform=linux/arm64 node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Fail fast on an unhandled rejection rather than continuing in an unknown state; ECS
# replaces the task and DynamoDB still holds every workflow.
ENV NODE_OPTIONS=--unhandled-rejections=strict

COPY --from=build /app/dist/api ./api

# Never run as root.
USER node

EXPOSE 8080

# ECS ignores this instruction — the authoritative copy is the container definition's
# healthCheck in infrastructure/cdk/lib/api/api-stack.ts. Kept here so `docker run` and
# docker-compose behave the same way locally.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.cjs"]
