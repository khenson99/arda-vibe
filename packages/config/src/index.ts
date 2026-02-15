import { z } from 'zod';
import pino from 'pino';
import 'dotenv/config';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

// ─── Environment Schema ───────────────────────────────────────────────
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Elasticsearch
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  // Google OAuth (login)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

  // Gmail OAuth (sending email from user accounts)
  GMAIL_REDIRECT_URI: z.string().url().optional(),

  // Token encryption (for securing OAuth tokens at rest)
  TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),

  // AI / LLM
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  // UPC lookup
  BARCODE_LOOKUP_API_KEY: z.string().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  // Email
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  EMAIL_FROM: z.string().email().default('noreply@arda.cards'),

  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default(''),
  SERVICE_HOST: z.string().default('localhost'),
  API_GATEWAY_PORT: z.coerce.number().default(3000),
  AUTH_SERVICE_PORT: z.coerce.number().default(3001),
  CATALOG_SERVICE_PORT: z.coerce.number().default(3002),
  KANBAN_SERVICE_PORT: z.coerce.number().default(3003),
  ORDERS_SERVICE_PORT: z.coerce.number().default(3004),
  NOTIFICATIONS_SERVICE_PORT: z.coerce.number().default(3005),
  ITEMS_SERVICE_PORT: z.coerce.number().default(3006),

  // Queue Risk Scheduler (Orders Service)
  ORDERS_QUEUE_RISK_SCAN_ENABLED: booleanFromEnv.default(true),
  ORDERS_QUEUE_RISK_SCAN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  ORDERS_QUEUE_RISK_LOOKBACK_DAYS: z.coerce.number().int().min(7).max(90).default(30),
  ORDERS_QUEUE_RISK_MIN_LEVEL: z.enum(['medium', 'high']).default('medium'),
  ORDERS_QUEUE_RISK_SCAN_LIMIT: z.coerce.number().int().positive().max(500).default(100),

  // Railway dynamic port (overrides service-specific ports)
  PORT: z.coerce.number().optional(),

  // Direct service URL overrides (Railway private networking)
  AUTH_SERVICE_URL: z.string().url().optional(),
  CATALOG_SERVICE_URL: z.string().url().optional(),
  KANBAN_SERVICE_URL: z.string().url().optional(),
  ORDERS_SERVICE_URL: z.string().url().optional(),
  NOTIFICATIONS_SERVICE_URL: z.string().url().optional(),
  ITEMS_SERVICE_URL: z.string().url().optional(),

  // AWS
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().default('arda-v2-dev'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
});

// ─── Parse & Validate ─────────────────────────────────────────────────
function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  return parsed.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;

// ─── Service URLs (for inter-service communication) ───────────────────
export const serviceUrls = {
  gateway: `http://${config.SERVICE_HOST}:${config.PORT || config.API_GATEWAY_PORT}`,
  auth: config.AUTH_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.AUTH_SERVICE_PORT}`,
  catalog: config.CATALOG_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.CATALOG_SERVICE_PORT}`,
  kanban: config.KANBAN_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.KANBAN_SERVICE_PORT}`,
  orders: config.ORDERS_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.ORDERS_SERVICE_PORT}`,
  notifications: config.NOTIFICATIONS_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.NOTIFICATIONS_SERVICE_PORT}`,
  items: config.ITEMS_SERVICE_URL || `http://${config.SERVICE_HOST}:${config.ITEMS_SERVICE_PORT}`,
} as const;

// ─── Structured Logger Factory ───────────────────────────────────────
export function createLogger(name: string) {
  return pino({
    name,
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    ...(config.NODE_ENV !== 'production' && {
      transport: { target: 'pino/file', options: { destination: 1 } },
      formatters: { level: (label: string) => ({ level: label }) },
    }),
  });
}
