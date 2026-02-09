import { z } from 'zod';
import 'dotenv/config';

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

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),

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
  SERVICE_HOST: z.string().default('localhost'),
  API_GATEWAY_PORT: z.coerce.number().default(3000),
  AUTH_SERVICE_PORT: z.coerce.number().default(3001),
  CATALOG_SERVICE_PORT: z.coerce.number().default(3002),
  KANBAN_SERVICE_PORT: z.coerce.number().default(3003),
  ORDERS_SERVICE_PORT: z.coerce.number().default(3004),
  NOTIFICATIONS_SERVICE_PORT: z.coerce.number().default(3005),

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
  gateway: `http://${config.SERVICE_HOST}:${config.API_GATEWAY_PORT}`,
  auth: `http://${config.SERVICE_HOST}:${config.AUTH_SERVICE_PORT}`,
  catalog: `http://${config.SERVICE_HOST}:${config.CATALOG_SERVICE_PORT}`,
  kanban: `http://${config.SERVICE_HOST}:${config.KANBAN_SERVICE_PORT}`,
  orders: `http://${config.SERVICE_HOST}:${config.ORDERS_SERVICE_PORT}`,
  notifications: `http://${config.SERVICE_HOST}:${config.NOTIFICATIONS_SERVICE_PORT}`,
} as const;
