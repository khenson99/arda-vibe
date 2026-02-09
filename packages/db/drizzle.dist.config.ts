import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: [
    './dist/schema/tenants.js',
    './dist/schema/users.js',
    './dist/schema/locations.js',
    './dist/schema/catalog.js',
    './dist/schema/kanban.js',
    './dist/schema/orders.js',
    './dist/schema/notifications.js',
    './dist/schema/billing.js',
    './dist/schema/audit.js',
  ],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
