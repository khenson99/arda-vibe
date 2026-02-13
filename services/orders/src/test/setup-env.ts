const TEST_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/arda_v2_test',
  JWT_SECRET: 'test-jwt-secret-minimum-32-characters-long',
  JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-minimum-32-characters-long',
};

for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  process.env[key] ??= value;
}
