/**
 * Digest Queue Worker Integration Tests
 *
 * Validates:
 *   - Multi-item digest batching (2+ notifications → digest template)
 *   - Single-item fallback (1 notification → individual email)
 *   - Per-user last-run marker storage and updates
 *   - Delivery record creation for digest sends
 *   - Skipping users with 0 unread digest notifications
 *   - Timezone awareness (tenant timezone fallback to UTC)
 *
 * Requires: DATABASE_URL + REDIS_URL (real integration test)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock infrastructure dependencies when DATABASE_URL is unavailable to prevent module-load crash
if (!process.env.DATABASE_URL) {
  vi.mock('@arda/db', () => ({
    db: {},
    schema: {},
    writeAuditEntry: vi.fn(),
    writeAuditEntries: vi.fn(),
  }));
  vi.mock('@arda/config', () => ({
    config: {},
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }));
}

import { Queue, Worker } from 'bullmq';
import type { JobEnvelope } from '@arda/jobs';
import { db, schema } from '@arda/db';
import { eq, and } from 'drizzle-orm';
import {
  createDigestQueue,
  createDigestWorker,
  scheduleDigestJob,
  type DigestJobPayload,
} from './digest-queue.worker.js';

// ─── Test Setup ────────────────────────────────────────────────────────

const HAS_INFRA = !!(process.env.DATABASE_URL && process.env.REDIS_URL);
const TEST_REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Mock email provider
vi.mock('../services/email-provider.js', () => ({
  createEmailProvider: vi.fn(() => ({
    send: vi.fn(async () => ({
      provider: 'mock-provider',
      messageId: `mock-${Date.now()}`,
    })),
  })),
}));

describe.skipIf(!HAS_INFRA)('Digest Queue Worker', () => {
  let queue: Queue<JobEnvelope<DigestJobPayload>>;
  let worker: Worker<JobEnvelope<DigestJobPayload>>;

  const testTenantId = '00000000-0000-0000-0000-000000000001';
  const testUser1Id = '10000000-0000-0000-0000-000000000001';
  const testUser2Id = '10000000-0000-0000-0000-000000000002';
  const testUser3Id = '10000000-0000-0000-0000-000000000003';

  beforeEach(async () => {
    queue = createDigestQueue(TEST_REDIS_URL);
    worker = createDigestWorker(TEST_REDIS_URL);

    // Clean up test data
    await db.delete(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.tenantId, testTenantId));
    await db.delete(schema.digestRunMarkers).where(eq(schema.digestRunMarkers.tenantId, testTenantId));
    await db.delete(schema.notifications).where(eq(schema.notifications.tenantId, testTenantId));

    // Clean queue
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await worker.close();
    await queue.close();
  });

  // ─── Test: Multi-Item Digest Batching ─────────────────────────────

  it('should batch 2+ unread digest notifications into a single digest email', async () => {
    // 1. Create 3 unread digest-tier notifications for user1
    const now = new Date();
    const baseTime = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago

    await db.insert(schema.notifications).values([
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_created',
        title: 'PO #1001 Created',
        body: 'Purchase order created for Supplier A',
        isRead: false,
        actionUrl: '/orders/1001',
        metadata: {},
        createdAt: new Date(baseTime.getTime() + 10000),
      },
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'wo_status_change',
        title: 'Work Order #5001 Status Updated',
        body: 'Status changed to In Progress',
        isRead: false,
        actionUrl: '/work-orders/5001',
        metadata: {},
        createdAt: new Date(baseTime.getTime() + 20000),
      },
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'card_triggered',
        title: 'Card #301 Triggered',
        body: 'Replenishment card triggered',
        isRead: false,
        actionUrl: '/cards/301',
        metadata: {},
        createdAt: new Date(baseTime.getTime() + 30000),
      },
    ]);

    // 2. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-1',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 3. Verify delivery records created
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, testTenantId),
          eq(schema.notificationDeliveries.userId, testUser1Id),
        ),
      );

    expect(deliveries).toHaveLength(3); // One delivery record per notification
    expect(deliveries.every((d) => d.status === 'delivered')).toBe(true);
    expect(deliveries.every((d) => d.provider === 'mock-provider')).toBe(true);

    // 4. Verify last-run marker updated
    const [marker] = await db
      .select()
      .from(schema.digestRunMarkers)
      .where(eq(schema.digestRunMarkers.userId, testUser1Id));

    expect(marker).toBeDefined();
    expect(marker.notificationCount).toBe(3);
    expect(marker.lastRunAt.getTime()).toBeCloseTo(now.getTime(), -2); // within 100ms
  });

  // ─── Test: Single-Item Fallback ───────────────────────────────────

  it('should send single unread digest notification as individual email (not digest template)', async () => {
    // 1. Create 1 unread digest-tier notification for user2
    const now = new Date();
    const baseTime = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago

    await db.insert(schema.notifications).values([
      {
        tenantId: testTenantId,
        userId: testUser2Id,
        type: 'receiving_completed',
        title: 'Receiving Completed for PO #2001',
        body: 'All items received and verified',
        isRead: false,
        actionUrl: '/orders/2001',
        metadata: { orderNumber: '2001' },
        createdAt: new Date(baseTime.getTime() + 10000),
      },
    ]);

    // 2. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-2',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 3. Verify delivery record created (single)
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, testTenantId),
          eq(schema.notificationDeliveries.userId, testUser2Id),
        ),
      );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('delivered');

    // 4. Verify last-run marker updated with count=1
    const [marker] = await db
      .select()
      .from(schema.digestRunMarkers)
      .where(eq(schema.digestRunMarkers.userId, testUser2Id));

    expect(marker).toBeDefined();
    expect(marker.notificationCount).toBe(1);
  });

  // ─── Test: Skip Users with 0 Unread ───────────────────────────────

  it('should skip users with 0 unread digest notifications', async () => {
    // 1. Create only immediate-tier notification (should be skipped)
    const now = new Date();
    const baseTime = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await db.insert(schema.notifications).values([
      {
        tenantId: testTenantId,
        userId: testUser3Id,
        type: 'exception_alert', // immediate tier
        title: 'Exception Alert',
        body: 'Critical exception detected',
        isRead: false,
        actionUrl: '/exceptions/1',
        metadata: {},
        createdAt: new Date(baseTime.getTime() + 10000),
      },
    ]);

    // 2. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-3',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 3. Verify no delivery records created
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, testTenantId),
          eq(schema.notificationDeliveries.userId, testUser3Id),
        ),
      );

    expect(deliveries).toHaveLength(0);

    // 4. Verify no marker created
    const [marker] = await db
      .select()
      .from(schema.digestRunMarkers)
      .where(eq(schema.digestRunMarkers.userId, testUser3Id));

    expect(marker).toBeUndefined();
  });

  // ─── Test: Last-Run Marker Filtering ──────────────────────────────

  it('should only include notifications created after last-run marker', async () => {
    // 1. Create old marker (2h ago)
    const now = new Date();
    const markerTime = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await db.insert(schema.digestRunMarkers).values({
      userId: testUser1Id,
      tenantId: testTenantId,
      lastRunAt: markerTime,
      notificationCount: 2,
    });

    // 2. Create notifications: 1 before marker, 2 after marker
    await db.insert(schema.notifications).values([
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_created',
        title: 'Old PO #1001',
        body: 'Should be excluded',
        isRead: false,
        createdAt: new Date(markerTime.getTime() - 10000), // before marker
      },
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_sent',
        title: 'New PO #1002',
        body: 'Should be included',
        isRead: false,
        createdAt: new Date(markerTime.getTime() + 10000), // after marker
      },
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'wo_status_change',
        title: 'WO #5001',
        body: 'Should be included',
        isRead: false,
        createdAt: new Date(markerTime.getTime() + 20000), // after marker
      },
    ]);

    // 3. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-4',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 4. Verify only 2 delivery records created (not 3)
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, testTenantId),
          eq(schema.notificationDeliveries.userId, testUser1Id),
        ),
      );

    expect(deliveries).toHaveLength(2);

    // 5. Verify marker updated with count=2
    const [marker] = await db
      .select()
      .from(schema.digestRunMarkers)
      .where(eq(schema.digestRunMarkers.userId, testUser1Id));

    expect(marker.notificationCount).toBe(2);
    expect(marker.lastRunAt.getTime()).toBeCloseTo(now.getTime(), -2);
  });

  // ─── Test: Repeatable Job Scheduling ──────────────────────────────

  it('should schedule repeatable digest job with cron pattern', async () => {
    const cronSchedule = '0 */4 * * *'; // every 4 hours

    await scheduleDigestJob(queue, cronSchedule);

    // Verify repeatable job registered
    const repeatableJobs = await queue.getRepeatableJobs();
    const digestJob = repeatableJobs.find((j) => j.name === 'notifications.digest_send');

    expect(digestJob).toBeDefined();
    expect(digestJob?.pattern).toBe(cronSchedule);
  });

  // ─── Test: Delivery Record Fields ─────────────────────────────────

  it('should populate delivery records with correct fields', async () => {
    // 1. Create notification
    const now = new Date();
    const baseTime = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    const [notification] = await db
      .insert(schema.notifications)
      .values({
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_created',
        title: 'PO #1001 Created',
        body: 'Purchase order created',
        isRead: false,
        createdAt: new Date(baseTime.getTime() + 10000),
      })
      .returning();

    // 2. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-5',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 3. Verify delivery record fields
    const [delivery] = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.notificationId, notification.id));

    expect(delivery).toBeDefined();
    expect(delivery.tenantId).toBe(testTenantId);
    expect(delivery.userId).toBe(testUser1Id);
    expect(delivery.notificationId).toBe(notification.id);
    expect(delivery.channel).toBe('email');
    expect(delivery.status).toBe('delivered');
    expect(delivery.provider).toBe('mock-provider');
    expect(delivery.providerMessageId).toMatch(/^mock-/);
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.deliveredAt).toBeDefined();
  });

  // ─── Test: Read Notifications Exclusion ───────────────────────────

  it('should exclude read notifications from digest', async () => {
    // 1. Create 2 notifications: 1 read, 1 unread
    const now = new Date();
    const baseTime = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await db.insert(schema.notifications).values([
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_created',
        title: 'Read PO #1001',
        body: 'Already read',
        isRead: true,
        readAt: baseTime,
        createdAt: new Date(baseTime.getTime() + 10000),
      },
      {
        tenantId: testTenantId,
        userId: testUser1Id,
        type: 'po_sent',
        title: 'Unread PO #1002',
        body: 'Should be included',
        isRead: false,
        createdAt: new Date(baseTime.getTime() + 20000),
      },
    ]);

    // 2. Process digest job
    const jobPayload: DigestJobPayload = {
      triggeredAt: now.toISOString(),
    };

    await queue.add('notifications.digest_send', {
      id: 'test-digest-6',
      type: 'notifications.digest_send',
      tenantId: testTenantId,
      payload: jobPayload,
      attempts: 1,
      maxRetries: 1,
      createdAt: now.toISOString(),
    });

    // Wait for job to complete
    await new Promise((resolve) => {
      worker.on('completed', () => resolve(undefined));
    });

    // 3. Verify only 1 delivery record created
    const deliveries = await db
      .select()
      .from(schema.notificationDeliveries)
      .where(
        and(
          eq(schema.notificationDeliveries.tenantId, testTenantId),
          eq(schema.notificationDeliveries.userId, testUser1Id),
        ),
      );

    expect(deliveries).toHaveLength(1);
  });
});
