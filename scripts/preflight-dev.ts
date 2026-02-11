/**
 * Arda V2 — Dev Startup Preflight
 *
 * Fail-fast checks before launching `npm run dev`.
 * Run with: npx tsx scripts/preflight-dev.ts
 */

import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEffectiveEnv,
  getEnvValue,
  loadEnvFile,
  validateEnv,
} from './lib/env-validation.js';

const PRECHECK_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 5173] as const;
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DATABASE_FALLBACK_PORT = 5432;
const REDIS_FALLBACK_PORT = 6379;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Endpoint {
  host: string;
  port: number;
}

export interface PortOwner {
  port: number;
  pid: number | null;
  command: string | null;
}

export function shouldSkipPreflight(env: NodeJS.ProcessEnv): boolean {
  return String(env.SKIP_PREFLIGHT || '').trim().toLowerCase() === 'true';
}

export function parseEndpointFromUrl(rawUrl: string, fallbackPort: number): Endpoint {
  const parsed = new URL(rawUrl);
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? Number(parsed.port) : fallbackPort,
  };
}

export function classifyReachabilityError(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: string }).code || '')
    : '';

  if (code === 'ETIMEDOUT') return 'connection timed out';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND') return 'host not found';
  if (code === 'EHOSTUNREACH') return 'host unreachable';
  return 'connection failed';
}

export async function checkTcpReachability(
  host: string,
  port: number,
  timeoutMs = 2000
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return await new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const settle = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle({ ok: true }));
    socket.once('timeout', () => settle({ ok: false, reason: 'connection timed out' }));
    socket.once('error', (error) => settle({ ok: false, reason: classifyReachabilityError(error) }));
  });
}

export function parseLsofOutput(port: number, output: string): PortOwner | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const firstProcessLine = lines[1];
  const cols = firstProcessLine.split(/\s+/);
  const command = cols[0] || null;
  const pidRaw = cols[1] || '';
  const pid = /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;

  return { port, pid, command };
}

function lookupPortOwner(port: number): PortOwner | null {
  try {
    const output = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf-8' }
    );
    return parseLsofOutput(port, output);
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string | Buffer };
    if (err.code === 1) {
      return null;
    }

    if (err.stdout) {
      const output = String(err.stdout);
      return parseLsofOutput(port, output);
    }

    return null;
  }
}

export function findPortConflicts(
  ports: readonly number[],
  portOwnerLookup: (port: number) => PortOwner | null = lookupPortOwner
): PortOwner[] {
  const conflicts: PortOwner[] = [];
  for (const port of ports) {
    const owner = portOwnerLookup(port);
    if (owner) {
      conflicts.push(owner);
    }
  }
  return conflicts;
}

export function formatPortOwner(owner: PortOwner): string {
  const pid = owner.pid ?? 'unknown';
  const command = owner.command ?? 'unknown';
  return `Port ${owner.port} is already in use by pid ${pid} (${command}).`;
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return resolve(process.argv[1]) === __filename;
}

export async function runPreflight(): Promise<number> {
  if (shouldSkipPreflight(process.env)) {
    console.log('[WARN] SKIP_PREFLIGHT=true detected. Skipping preflight checks.');
    return 0;
  }

  const rootDir = resolve(__dirname, '..');
  const envPath = resolve(rootDir, '.env');
  const envVars = loadEnvFile(envPath);
  const effectiveEnv = buildEffectiveEnv(envVars, process.env);

  console.log('');
  console.log('Arda V2 — Dev Startup Preflight');
  console.log('================================');
  console.log('');

  const envValidation = validateEnv(effectiveEnv);
  if (envValidation.errors.length > 0) {
    console.log('[FAIL] Environment validation');
    for (const error of envValidation.errors) {
      console.log(`  - ${error}`);
    }
    console.log('  Fix: Update .env or exported shell variables and retry.');
    console.log('');
    return 1;
  }
  console.log('[PASS] Environment validation');
  for (const warning of envValidation.warnings) {
    console.log(`  [WARN] ${warning}`);
  }

  const databaseUrl = getEnvValue(effectiveEnv, 'DATABASE_URL');
  const redisUrl = getEnvValue(effectiveEnv, 'REDIS_URL') || DEFAULT_REDIS_URL;

  if (!databaseUrl) {
    console.log('[FAIL] Dependency reachability');
    console.log('  - DATABASE_URL is required and is not set.');
    console.log('  Fix: Set DATABASE_URL in .env and retry.');
    console.log('');
    return 1;
  }

  const dependencies = [
    { name: 'PostgreSQL', endpoint: parseEndpointFromUrl(databaseUrl, DATABASE_FALLBACK_PORT) },
    { name: 'Redis', endpoint: parseEndpointFromUrl(redisUrl, REDIS_FALLBACK_PORT) },
  ];

  const dependencyFailures: string[] = [];
  for (const dependency of dependencies) {
    const result = await checkTcpReachability(dependency.endpoint.host, dependency.endpoint.port, 2000);
    if (!result.ok) {
      dependencyFailures.push(
        `${dependency.name} unreachable at ${dependency.endpoint.host}:${dependency.endpoint.port} (${result.reason})`
      );
    }
  }

  if (dependencyFailures.length > 0) {
    console.log('[FAIL] Dependency reachability');
    for (const failure of dependencyFailures) {
      console.log(`  - ${failure}`);
    }
    console.log('  Fix: Start local dependencies with `docker compose up -d postgres redis`.');
    console.log('');
    return 1;
  }
  console.log('[PASS] Dependency reachability');

  const portConflicts = findPortConflicts(PRECHECK_PORTS);
  if (portConflicts.length > 0) {
    console.log('[FAIL] Port availability');
    for (const conflict of portConflicts) {
      console.log(`  - ${formatPortOwner(conflict)}`);
    }
    console.log('  Fix: Stop conflicting processes or change local port assignments.');
    console.log('');
    return 1;
  }
  console.log('[PASS] Port availability');
  console.log('');
  console.log('Preflight passed');
  console.log('');
  return 0;
}

if (isExecutedDirectly()) {
  runPreflight()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error('[FAIL] Preflight crashed unexpectedly');
      console.error(error);
      process.exit(1);
    });
}
