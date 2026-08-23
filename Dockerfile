# Build stage: bundle the API to a single file so the runtime image carries no
# node_modules, no source and no package manager.
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Runtime stage.
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Fail fast on an unhandled rejection rather than continuing in an unknown state; ECS
# replaces the task and DynamoDB still holds every workflow.
ENV NODE_OPTIONS=--unhandled-rejections=strict

COPY --from=build /app/dist/api ./api

# Never run as root.
USER node

EXPOSE 8080

# The container-level check is liveness only. Readiness belongs to the load balancer,
# which must be the one to take a draining task out of rotation.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.cjs"]
