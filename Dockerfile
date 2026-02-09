# ─── Multi-stage Dockerfile for Arda V2 services ─────────────────────
# Build context: repo root
# Usage: docker build --build-arg SERVICE=kanban -t arda/kanban .
#
# SERVICE arg maps to directory name under services/ (e.g. "kanban", "auth")

ARG NODE_VERSION=20-alpine

# ─── Stage 1: Install dependencies ───────────────────────────────────
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

# Copy workspace root manifests
COPY package.json package-lock.json turbo.json tsconfig.base.json ./

# Copy all package/service manifests for npm ci
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/auth-utils/package.json packages/auth-utils/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

COPY services/api-gateway/package.json services/api-gateway/package.json
COPY services/auth/package.json services/auth/package.json
COPY services/catalog/package.json services/catalog/package.json
COPY services/kanban/package.json services/kanban/package.json
COPY services/notifications/package.json services/notifications/package.json
COPY services/orders/package.json services/orders/package.json

RUN npm ci --ignore-scripts

# ─── Stage 2: Build all packages and the target service ──────────────
FROM deps AS builder

ARG SERVICE

# Copy all source code
COPY packages/ packages/
COPY services/ services/

# Build all shared packages + the target service
# (all packages are built so the runner stage can unconditionally COPY them)
RUN npx turbo build --filter="./packages/*" --filter=@arda/${SERVICE}-service \
    || npx turbo build --filter="./packages/*" --filter=@arda/${SERVICE}

# ─── Stage 3: Production runtime ─────────────────────────────────────
FROM node:${NODE_VERSION} AS runner

ARG SERVICE
ENV NODE_ENV=production
ENV SERVICE_NAME=${SERVICE}

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/auth-utils/package.json packages/auth-utils/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY services/${SERVICE}/package.json services/${SERVICE}/package.json

RUN npm ci --omit=dev --ignore-scripts

# Copy built artifacts from builder
COPY --from=builder /app/packages/config/dist packages/config/dist
COPY --from=builder /app/packages/config/package.json packages/config/package.json

COPY --from=builder /app/packages/db/dist packages/db/dist
COPY --from=builder /app/packages/db/package.json packages/db/package.json

COPY --from=builder /app/packages/events/dist packages/events/dist
COPY --from=builder /app/packages/events/package.json packages/events/package.json

COPY --from=builder /app/packages/auth-utils/dist packages/auth-utils/dist
COPY --from=builder /app/packages/auth-utils/package.json packages/auth-utils/package.json

COPY --from=builder /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/package.json

COPY --from=builder /app/services/${SERVICE}/dist services/${SERVICE}/dist
COPY --from=builder /app/services/${SERVICE}/package.json services/${SERVICE}/package.json

# Ensure all files are readable (COPY --from preserves source permissions)
RUN chmod -R a+rX /app

# Non-root user for security
RUN addgroup -g 1001 -S arda && \
    adduser -S arda -u 1001 -G arda
USER arda

EXPOSE 3000

CMD ["sh", "-c", "node services/${SERVICE_NAME}/dist/index.js"]
