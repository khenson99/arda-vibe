import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './src/schema/tenants.ts',
    './src/schema/users.ts',
    './src/schema/locations.ts',
    './src/schema/catalog.ts',
    './src/schema/kanban.ts',
    './src/schema/orders.ts',
    './src/schema/notifications.ts',
    './src/schema/billing.ts',
    './src/schema/audit.ts',
    './src/schema/analytics.ts',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
