import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted State ──────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  // Preferences looked up per query: array of results per call
  userPrefs: [] as Array<Array<{ isEnabled: boolean }>>,
  tenantPrefs: [] as Array<Array<{ isEnabled: boolean }>>,
  userEmail: null as string | null,
  insertedDeliveries: [] as Array<Record<string, unknown>>,
  enqueuedEmails: [] as Array<Record<string, unknown>>,
  // Track which DB query we're on
  userPrefCallIndex: 0,
  tenantPrefCallIndex: 0,
}));

// ─── Mock @arda/config ──────────────────────────────────────────────────

vi.mock('@arda/config', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// ─── Mock unsubscribe-token ─────────────────────────────────────────────

vi.mock('./unsubscribe-token.js', () => ({
  generateUnsubscribeToken: vi.fn(() => 'mock-unsub-token'),
  buildUnsubscribeUrl: vi.fn(
    (baseUrl: string, token: string) => `${baseUrl}/api/notifications/unsubscribe?token=${token}`,
  ),
  buildUnsubscribeHeaders: vi.fn((url: string) => ({
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  })),
}));

// ─── Mock templates ─────────────────────────────────────────────────────

vi.mock('../templates/index.js', () => ({
  renderTemplate: vi.fn(() => ({
    subject: 'Test Subject',
    html: '<p>Test HTML</p>',
  })),
}));

// ─── Mock email queue worker enqueue ────────────────────────────────────

vi.mock('../workers/email-queue.worker.js', () => ({
  enqueueEmail: vi.fn(async (_queue: unknown, payload: unknown) => {
    testState.enqueuedEmails.push(payload as Record<string, unknown>);
    return {};
  }),
}));

// ─── Mock drizzle-orm ───────────────────────────────────────────────────

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
}));

// ─── Mock @arda/db ──────────────────────────────────────────────────────

const schemaMock = vi.hoisted(() => ({
  notificationPreferences: {
    tenantId: 'notificationPreferences.tenantId',
    userId: 'notificationPreferences.userId',
    notificationType: 'notificationPreferences.notificationType',
    channel: 'notificationPreferences.channel',
    isEnabled: 'notificationPreferences.isEnabled',
  },
  tenantDefaultPreferences: {
    tenantId: 'tenantDefaultPreferences.tenantId',
    notificationType: 'tenantDefaultPreferences.notificationType',
    channel: 'tenantDefaultPreferences.channel',
    isEnabled: 'tenantDefaultPreferences.isEnabled',
  },
  users: {
    id: 'users.id',
    email: 'users.email',
  },
  notificationDeliveries: {
    id: 'notificationDeliveries.id',
  },
}));

/**
 * Build a chainable select builder that resolves to the given result.
 */
function makeSelectBuilder(result: unknown) {
  const builder: any = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  // Support iteration (destructuring [first])
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

/**
 * The db mock dynamically resolves queries based on which schema table
 * is referenced in the `.from()` call.
 *
 * We track calls per-table so independent preference checks resolve
 * to distinct results.
 */
const dbMock = vi.hoisted(() => {
  const mock: any = {
    select: vi.fn(),
    insert: vi.fn(),
  };
  return mock;
});

function setupDbMock() {
  // Reset call indices
  testState.userPrefCallIndex = 0;
  testState.tenantPrefCallIndex = 0;

  dbMock.select.mockImplementation(() => {
    const builder: any = {};
    builder.from = vi.fn((table: unknown) => {
      builder._table = table;
      return builder;
    });
    builder.where = vi.fn(() => {
      const table = builder._table;
      if (table === schemaMock.notificationPreferences) {
        const idx = testState.userPrefCallIndex++;
        const result = testState.userPrefs[idx] || [];
        return makeSelectBuilder(result);
      }
      if (table === schemaMock.tenantDefaultPreferences) {
        const idx = testState.tenantPrefCallIndex++;
        const result = testState.tenantPrefs[idx] || [];
        return makeSelectBuilder(result);
      }
      if (table === schemaMock.users) {
        const email = testState.userEmail;
        return makeSelectBuilder(email ? [{ email }] : []);
      }
      return makeSelectBuilder([]);
    });
    return builder;
  });

  dbMock.insert.mockImplementation(() => {
    const insertBuilder: any = {};
    insertBuilder.values = vi.fn((values: unknown) => {
      testState.insertedDeliveries.push(values as Record<string, unknown>);
      return {
        returning: vi.fn(async () => [{ id: `delivery-${testState.insertedDeliveries.length}` }]),
      };
    });
    return insertBuilder;
  });
}

vi.mock('@arda/db', () => ({
  db: dbMock,
  schema: schemaMock,
}));

// ─── Import SUT (after mocks) ───────────────────────────────────────────

import { dispatchNotificationChannels } from './channel-dispatch.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<Parameters<typeof dispatchNotificationChannels>[0]> = {}) {
  return {
    notificationId: 'notif-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    type: 'exception_alert',
    title: 'Test Exception',
    body: 'Something went wrong',
    actionUrl: '/receiving/exceptions/exc-1',
    metadata: { severity: 'high', exceptionType: 'Short Shipment' },
    ...overrides,
  };
}

function makeCtx(): Parameters<typeof dispatchNotificationChannels>[1] {
  return {
    emailQueue: { add: vi.fn() } as any,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('channel-dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.userPrefs = [];
    testState.tenantPrefs = [];
    testState.userEmail = 'user@example.com';
    testState.insertedDeliveries = [];
    testState.enqueuedEmails = [];
    testState.userPrefCallIndex = 0;
    testState.tenantPrefCallIndex = 0;
    setupDbMock();
  });

  // ─── Email Enabled → Immediate ─────────────────────────────────────

  it('enqueues email for immediate-tier type when user has email enabled', async () => {
    // User preference: email enabled for exception_alert
    testState.userPrefs = [
      [{ isEnabled: true }],   // email channel check
    ];
    // webhook: no pref → fallback false
    testState.tenantPrefs = [];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    // Should create delivery record for email
    expect(testState.insertedDeliveries.length).toBeGreaterThanOrEqual(1);
    const emailDelivery = testState.insertedDeliveries.find(
      (d) => d.channel === 'email',
    );
    expect(emailDelivery).toBeDefined();
    expect(emailDelivery!.status).toBe('pending');

    // Should enqueue email job
    expect(testState.enqueuedEmails).toHaveLength(1);
    expect(testState.enqueuedEmails[0]).toEqual(
      expect.objectContaining({
        notificationId: 'notif-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        to: 'user@example.com',
        subject: 'Test Subject',
        html: '<p>Test HTML</p>',
      }),
    );
  });

  // ─── Email Disabled → No Email ─────────────────────────────────────

  it('does not enqueue email when user has email disabled', async () => {
    testState.userPrefs = [
      [{ isEnabled: false }],  // email channel disabled
    ];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    expect(testState.enqueuedEmails).toHaveLength(0);
    // No email delivery record should be created
    const emailDeliveries = testState.insertedDeliveries.filter(
      (d) => d.channel === 'email',
    );
    expect(emailDeliveries).toHaveLength(0);
  });

  // ─── No User Pref, Tenant Default Enabled ─────────────────────────

  it('uses tenant default when no user preference exists', async () => {
    // No user-level preferences at all
    testState.userPrefs = [];
    // Tenant default: email enabled
    testState.tenantPrefs = [
      [{ isEnabled: true }],   // email channel
    ];

    const params = makeParams({ type: 'stockout_warning' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    expect(testState.enqueuedEmails).toHaveLength(1);
    expect(testState.enqueuedEmails[0]).toEqual(
      expect.objectContaining({
        notificationId: 'notif-1',
        to: 'user@example.com',
      }),
    );
  });

  // ─── No User Pref, No Tenant Default → Hardcoded Fallback ────────

  it('falls back to hardcoded defaults when no preferences exist (immediate → email enabled)', async () => {
    // No preferences at all
    testState.userPrefs = [];
    testState.tenantPrefs = [];

    const params = makeParams({ type: 'exception_alert' }); // immediate tier
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    // Hardcoded: immediate + email = true
    expect(testState.enqueuedEmails).toHaveLength(1);
  });

  it('falls back to hardcoded defaults when no preferences exist (digest → email disabled)', async () => {
    testState.userPrefs = [];
    testState.tenantPrefs = [];

    const params = makeParams({ type: 'po_created' }); // digest tier
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    // Hardcoded: digest + email = false → no email
    expect(testState.enqueuedEmails).toHaveLength(0);
  });

  // ─── Digest Tier → No Immediate Email ─────────────────────────────

  it('does not send immediate email for digest-tier types even when email enabled', async () => {
    testState.userPrefs = [
      [{ isEnabled: true }],  // email enabled
    ];

    const params = makeParams({ type: 'card_triggered' }); // digest
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    // Email enabled but digest tier → no immediate email enqueued
    expect(testState.enqueuedEmails).toHaveLength(0);
    // No email delivery record created (digest aggregation later)
    const emailDeliveries = testState.insertedDeliveries.filter(
      (d) => d.channel === 'email',
    );
    expect(emailDeliveries).toHaveLength(0);
  });

  // ─── Delivery Record Created ──────────────────────────────────────

  it('creates delivery record with correct fields for email dispatch', async () => {
    testState.userPrefs = [
      [{ isEnabled: true }],  // email
    ];

    const params = makeParams({ type: 'production_hold' }); // immediate
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    const emailDelivery = testState.insertedDeliveries.find(
      (d) => d.channel === 'email',
    );
    expect(emailDelivery).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        notificationId: 'notif-1',
        userId: 'user-1',
        channel: 'email',
        status: 'pending',
        attemptCount: 0,
      }),
    );
  });

  // ─── Webhook Creates Delivery Record ──────────────────────────────

  it('creates webhook delivery record when webhook channel is enabled', async () => {
    // email: disabled
    testState.userPrefs = [
      [{ isEnabled: false }],  // email disabled
      [{ isEnabled: true }],   // webhook enabled
    ];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    const webhookDelivery = testState.insertedDeliveries.find(
      (d) => d.channel === 'webhook',
    );
    expect(webhookDelivery).toBeDefined();
    expect(webhookDelivery).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        notificationId: 'notif-1',
        userId: 'user-1',
        channel: 'webhook',
        status: 'pending',
      }),
    );
  });

  // ─── No User Email → Skip Email Dispatch ──────────────────────────

  it('skips email dispatch when user has no email address', async () => {
    testState.userEmail = null;
    testState.userPrefs = [
      [{ isEnabled: true }],  // email enabled
    ];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    expect(testState.enqueuedEmails).toHaveLength(0);
  });

  // ─── Unknown Tier → Skips ─────────────────────────────────────────

  it('gracefully skips dispatch for unknown notification type', async () => {
    const params = makeParams({ type: 'unknown_type' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    expect(testState.enqueuedEmails).toHaveLength(0);
    expect(testState.insertedDeliveries).toHaveLength(0);
  });

  // ─── Unsubscribe Headers ──────────────────────────────────────────

  it('includes unsubscribe headers in enqueued email', async () => {
    testState.userPrefs = [
      [{ isEnabled: true }],  // email
    ];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    expect(testState.enqueuedEmails).toHaveLength(1);
    expect(testState.enqueuedEmails[0].headers).toEqual(
      expect.objectContaining({
        'List-Unsubscribe': expect.stringContaining('mock-unsub-token'),
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }),
    );
  });

  // ─── Multiple Channels ────────────────────────────────────────────

  it('dispatches both email and webhook when both are enabled', async () => {
    testState.userPrefs = [
      [{ isEnabled: true }],   // email
      [{ isEnabled: true }],   // webhook
    ];

    const params = makeParams({ type: 'exception_alert' });
    const ctx = makeCtx();

    await dispatchNotificationChannels(params, ctx);

    // Email + webhook delivery records
    expect(testState.insertedDeliveries).toHaveLength(2);
    expect(testState.insertedDeliveries.some((d) => d.channel === 'email')).toBe(true);
    expect(testState.insertedDeliveries.some((d) => d.channel === 'webhook')).toBe(true);

    // Email enqueued
    expect(testState.enqueuedEmails).toHaveLength(1);
  });
});
