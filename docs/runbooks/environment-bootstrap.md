# Environment Bootstrap Runbook

Complete guide for setting up Arda V2 development and staging environments.

## Prerequisites

| Tool | Minimum Version | Check Command |
|------|----------------|---------------|
| Node.js | 20.0.0 | `node --version` |
| npm | 10.0.0 | `npm --version` |
| Docker | 24.0.0 | `docker --version` |
| Docker Compose | 2.20.0 | `docker compose version` |
| Git | 2.40.0 | `git --version` |

PostgreSQL and Redis run inside Docker -- no local installation needed.

## Quick Start (One Command)

```bash
./scripts/bootstrap.sh
```

This script will:
1. Check all prerequisites
2. Copy `.env.example` to `.env` (if `.env` does not exist)
3. Start Docker containers (PostgreSQL, Redis)
4. Wait for database and Redis readiness
5. Install npm dependencies
6. Run database migrations
7. Build all packages

## Manual Setup

### 1. Clone and Install

```bash
git clone <repo-url> arda-v2
cd arda-v2
npm ci
```

### 2. Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` with your local values. At minimum, the defaults work for local development. See the **Environment Variable Reference** below for all options.

### 3. Start Infrastructure

```bash
docker compose up -d postgres redis
```

Wait for health checks:

```bash
docker compose ps  # Both should show "healthy"
```

### 4. Database Setup

```bash
# Apply migrations
./scripts/migrate.sh migrate

# Or push schema directly (dev only)
./scripts/migrate.sh push
```

### 5. Build and Run

```bash
npm run build      # Build all packages and services
npm run dev        # Start all services in dev mode
```

Individual services:

```bash
npm run dev --filter=@arda/web           # Frontend only
npm run dev --filter=@arda/api-gateway   # API gateway only
npm run dev --filter=@arda/orders        # Orders service only
```

## Environment Variable Reference

### Required Variables

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection string | _(none)_ | `postgresql://arda:arda_dev_password@localhost:5432/arda_v2` |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | _(none)_ | `change-me-in-production-use-a-64-char-random-string` |
| `JWT_REFRESH_SECRET` | JWT refresh token secret (min 32 chars) | _(none)_ | `change-me-too-different-from-above` |

### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection URL | _(required)_ |

### Redis

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |

### Elasticsearch

| Variable | Description | Default |
|----------|-------------|---------|
| `ELASTICSEARCH_URL` | Elasticsearch connection URL | `http://localhost:9200` |

### Authentication (JWT)

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Signing secret for access tokens | _(required, min 32 chars)_ |
| `JWT_REFRESH_SECRET` | Signing secret for refresh tokens | _(required, min 32 chars)_ |
| `JWT_EXPIRY` | Access token lifetime | `15m` |
| `JWT_REFRESH_EXPIRY` | Refresh token lifetime | `7d` |

### Google OAuth (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | _(optional)_ |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | _(optional)_ |
| `GOOGLE_CALLBACK_URL` | OAuth callback URL (`/api/auth/google/link/callback`), required in production for Gmail linking | _(optional)_ |

### Stripe (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Stripe API secret key | _(optional)_ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | _(optional)_ |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key | _(optional)_ |

### Email (SMTP)

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname | `localhost` |
| `SMTP_PORT` | SMTP server port | `1025` |
| `SMTP_USER` | SMTP username | _(empty)_ |
| `SMTP_PASS` | SMTP password | _(empty)_ |
| `EMAIL_FROM` | Default sender address | `noreply@arda.cards` |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment name | `development` |
| `APP_URL` | Frontend URL | `http://localhost:5173` |
| `SERVICE_HOST` | Host for inter-service communication | `localhost` |
| `API_GATEWAY_PORT` | API gateway port | `3000` |
| `AUTH_SERVICE_PORT` | Auth service port | `3001` |
| `CATALOG_SERVICE_PORT` | Catalog service port | `3002` |
| `KANBAN_SERVICE_PORT` | Kanban service port | `3003` |
| `ORDERS_SERVICE_PORT` | Orders service port | `3004` |
| `NOTIFICATIONS_SERVICE_PORT` | Notifications service port | `3005` |
| `PORT` | Railway dynamic port override | _(optional)_ |

### Service URL Overrides (Railway Private Networking)

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_SERVICE_URL` | Direct auth service URL | _(optional)_ |
| `CATALOG_SERVICE_URL` | Direct catalog service URL | _(optional)_ |
| `KANBAN_SERVICE_URL` | Direct kanban service URL | _(optional)_ |
| `ORDERS_SERVICE_URL` | Direct orders service URL | _(optional)_ |
| `NOTIFICATIONS_SERVICE_URL` | Direct notifications service URL | _(optional)_ |

### Orders Queue Risk Scheduler

| Variable | Description | Default |
|----------|-------------|---------|
| `ORDERS_QUEUE_RISK_SCAN_ENABLED` | Enable risk scanning | `true` |
| `ORDERS_QUEUE_RISK_SCAN_INTERVAL_MINUTES` | Scan interval in minutes | `15` |
| `ORDERS_QUEUE_RISK_LOOKBACK_DAYS` | Days to look back (7-90) | `30` |
| `ORDERS_QUEUE_RISK_MIN_LEVEL` | Minimum risk level to flag | `medium` |
| `ORDERS_QUEUE_RISK_SCAN_LIMIT` | Max records per scan (max 500) | `100` |

### AWS / S3

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `us-east-1` |
| `AWS_S3_BUCKET` | S3 bucket name | `arda-v2-dev` |
| `AWS_ACCESS_KEY_ID` | AWS access key | _(optional)_ |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | _(optional)_ |

## Local vs Staging Differences

| Aspect | Local Development | Staging |
|--------|------------------|---------|
| **Database** | Docker PostgreSQL on localhost:5432 | Railway-managed PostgreSQL |
| **Redis** | Docker Redis on localhost:6379 | Railway-managed Redis |
| **Elasticsearch** | Docker ES on localhost:9200 | Managed Elasticsearch |
| **Object Storage** | Local filesystem or MinIO | AWS S3 |
| **Services** | Individual processes via `npm run dev` | Docker containers on Railway |
| **Ports** | Each service on its own port (3000-3005) | All services on PORT=3000, routed by Railway |
| **Service Discovery** | `localhost:<port>` | Railway private networking URLs |
| **Email** | MailHog (SMTP on 1025, UI on 8025) | SES or production SMTP |
| **NODE_ENV** | `development` | `production` |
| **JWT Secrets** | Dev defaults from `.env.example` | Strong random secrets |
| **Hot Reload** | Yes (`npm run dev` uses tsx/tsc --watch) | No (built Docker images) |

## Troubleshooting

### Docker containers not starting

```bash
# Check logs
docker compose logs postgres
docker compose logs redis

# Reset volumes (destroys data)
docker compose down -v
docker compose up -d
```

### Database connection refused

1. Verify PostgreSQL is healthy: `docker compose ps`
2. Check `DATABASE_URL` matches Docker config
3. Default: `postgresql://arda:arda_dev_password@localhost:5432/arda_v2`

### Redis connection refused

1. Verify Redis is healthy: `docker compose ps`
2. Check `REDIS_URL` is `redis://localhost:6379`

### Port already in use

```bash
# Find process using port
lsof -i :3000

# Kill it
kill -9 <PID>
```

### Migration failures

```bash
# Check migration status
./scripts/migrate.sh status

# Push schema directly (dev only)
./scripts/migrate.sh push
```

### npm install failures

```bash
# Clear caches and retry
npm cache clean --force
rm -rf node_modules
rm package-lock.json
npm install
```

### TypeScript build errors

```bash
# Clean all build artifacts
npm run clean

# Rebuild
npm run build
```

### Environment validation errors

```bash
# Run the validation script
npx tsx scripts/validate-env.ts

# It will report which variables are missing or invalid
```
