import { eq, and, isNull } from 'drizzle-orm';
import { db, schema, writeAuditEntry } from '@arda/db';
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';
import { OAuth2Client } from 'google-auth-library';
import { config } from '@arda/config';
import crypto from 'crypto';
import { sendPasswordResetEmail } from './email.service.js';
import {
  AuthAuditAction,
  writeAuthAuditEntry,
  type AuthAuditContext,
} from './auth-audit.js';

const { users, tenants, refreshTokens, oauthAccounts, passwordResetTokens } = schema;
const PASSWORD_RESET_EXPIRY_MINUTES = 60;

// ─── Types ────────────────────────────────────────────────────────────
interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  companySlug?: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface ForgotPasswordInput {
  email: string;
}

interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface AuthResponse {
  tokens: TokenPair;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    tenantId: string;
    tenantName: string;
  };
}

export interface GoogleOAuthProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
}

export interface GoogleOAuthTokenBundle {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface GmailDiscoveredSupplier {
  vendorId: string;
  vendorName: string;
  domain: string;
  messageCount: number;
  lastSeenAt: string;
}

export interface GmailSupplierDiscoveryResult {
  suppliers: GmailDiscoveredSupplier[];
  scannedMessages: number;
  hasMore: boolean;
}

export interface GmailDetectedOrderItem {
  name: string;
  quantity: number;
  sku?: string;
  asin?: string;
  upc?: string;
  unitPrice?: number;
  imageUrl?: string;
  packSize?: string;
  lineTotal?: number;
  quantityOrdered?: number;
  dateOrdered?: string;
  messageType?: 'receipt' | 'shipping' | 'delivery';
  url?: string;
}

export interface GmailDetectedOrder {
  vendorId: string;
  vendorName: string;
  domain?: string;
  orderDate: string;
  orderNumber: string;
  summary?: string;
  confidence: number;
  items: GmailDetectedOrderItem[];
}

export interface GmailOrderDiscoveryResult {
  orders: GmailDetectedOrder[];
  suppliers: GmailDiscoveredSupplier[];
  scannedMessages: number;
  hasMore: boolean;
  analysisMode: 'ai' | 'heuristic';
  analysisWarning?: string;
}

export interface OrderEnrichmentInput {
  vendorId: string;
  vendorName: string;
  orderDate: string;
  orderNumber: string;
  items: GmailDetectedOrderItem[];
}

export interface AiEmailEnrichedProduct {
  name: string;
  sku?: string;
  asin?: string;
  upc?: string;
  imageUrl?: string;
  vendorId: string;
  vendorName: string;
  productUrl?: string;
  description?: string;
  unitPrice?: number;
  moq: number;
  orderCadenceDays?: number;
  recommendedOrderQuantity?: number;
  recommendedMinQuantity?: number;
  statedLeadTimeDays?: number;
  safetyStockDays?: number;
  orderHistorySampleSize?: number;
  confidence: number;
  needsReview: boolean;
}

export interface AiEmailEnrichmentResult {
  products: AiEmailEnrichedProduct[];
  mode: 'ai' | 'heuristic';
  warning?: string;
}

export interface AiImagePrediction {
  label: string;
  confidence: number;
  suggestedProduct?: Partial<AiEmailEnrichedProduct>;
}

export interface AiImageAnalysisResult {
  predictions: AiImagePrediction[];
}

export interface UpcLookupProduct {
  upc: string;
  name: string;
  brand?: string;
  description?: string;
  imageUrl?: string;
  category?: string;
  productUrl?: string;
  moq?: number;
  confidence: number;
}

export interface UpcLookupResult {
  upc: string;
  found: boolean;
  provider: 'barcodelookup' | 'openfoodfacts' | 'none';
  product?: UpcLookupProduct;
}

const GMAIL_DISCOVERY_DOMAIN_DENYLIST = new Set([
  'gmail.com',
  'googlemail.com',
  'google.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

const GMAIL_LOOKBACK_DAYS_DEFAULT = 180;
const GMAIL_LOOKBACK_DAYS_MIN = 30;
const GMAIL_LOOKBACK_DAYS_MAX = 365;
const GMAIL_PURCHASE_QUERY_CLAUSE =
  '(subject:("order confirmation" OR receipt OR invoice OR shipped OR shipping OR delivery OR tracking OR "proof of delivery") OR has:attachment) -subject:(newsletter OR marketing OR webinar OR calendar OR invitation OR subscription OR renewal OR statement OR autopay)';

interface KnownVendorDefinition {
  id: string;
  name: string;
  domains: string[];
  priority: number;
}

const KNOWN_VENDORS: KnownVendorDefinition[] = [
  {
    id: 'amazon',
    name: 'Amazon',
    domains: ['amazon.com', 'amazonbusiness.com', 'amzn.com'],
    priority: 0,
  },
  { id: 'uline', name: 'Uline', domains: ['uline.com'], priority: 1 },
  { id: 'fastenal', name: 'Fastenal', domains: ['fastenal.com'], priority: 1 },
  {
    id: 'msc',
    name: 'MSC Industrial',
    domains: ['mscdirect.com', 'mscindustrial.com'],
    priority: 1,
  },
  { id: 'grainger', name: 'Grainger', domains: ['grainger.com', 'zoro.com'], priority: 1 },
  { id: 'digikey', name: 'DigiKey', domains: ['digikey.com'], priority: 1 },
  { id: 'mouser', name: 'Mouser Electronics', domains: ['mouser.com'], priority: 1 },
];

const KNOWN_VENDOR_BY_ID = new Map(KNOWN_VENDORS.map((vendor) => [vendor.id, vendor]));
const AMAZON_VENDOR_IDS = new Set(['amazon']);
const INDUSTRIAL_VENDOR_IDS = new Set(['uline', 'fastenal', 'msc', 'grainger', 'digikey', 'mouser']);

const OPENAI_COMPLETIONS_PATH = '/chat/completions';

type PurchaseMessageType = 'receipt' | 'shipping' | 'delivery';

const FINANCIAL_DOMAIN_DENYLIST = new Set([
  'americanexpress.com',
  'bankofamerica.com',
  'barclays.com',
  'capitalone.com',
  'chase.com',
  'citi.com',
  'citibank.com',
  'discover.com',
  'fidelity.com',
  'hsbc.com',
  'intuit.com',
  'mastercard.com',
  'paypal.com',
  'pnc.com',
  'schwab.com',
  'stripe.com',
  'synchrony.com',
  'td.com',
  'usbank.com',
  'venmo.com',
  'visa.com',
  'wellsfargo.com',
]);

const NEGATIVE_MESSAGE_PATTERNS = [
  /\bcalendar invite\b/i,
  /\bmeeting invite\b/i,
  /\binvitation\b/i,
  /\bnewsletter\b/i,
  /\bmarketing\b/i,
  /\bpromotion(al)?\b/i,
  /\bpromo code\b/i,
  /\bsubscription\b/i,
  /\brenewal\b/i,
  /\btrial ending\b/i,
  /\bautopay\b/i,
  /\bpayment due\b/i,
  /\bstatement ready\b/i,
  /\bbank alert\b/i,
  /\bfraud alert\b/i,
  /\bsecurity alert\b/i,
];

const RECEIPT_PATTERNS = [
  /\breceipt\b/i,
  /\binvoice\b/i,
  /\border confirmation\b/i,
  /\bpurchase confirmation\b/i,
  /\byour order\b/i,
  /\bpaid\b/i,
];

const SHIPPING_PATTERNS = [
  /\bshipped\b/i,
  /\bshipping\b/i,
  /\bout for shipment\b/i,
  /\btracking\b/i,
  /\bcarrier\b/i,
  /\bestimated arrival\b/i,
];

const DELIVERY_PATTERNS = [
  /\bdelivered\b/i,
  /\bdelivery\b/i,
  /\bproof of delivery\b/i,
  /\barrived\b/i,
  /\bleft at\b/i,
];

const INDUSTRIAL_KEYWORDS = [
  'industrial',
  'distributor',
  'distribution',
  'supplier',
  'supplies',
  'mro',
  'fastener',
  'hardware',
  'tool',
  'electrical',
  'automation',
  'hydraulic',
  'pneumatic',
  'warehouse',
  'manufacturing',
  'component',
  'bearing',
  'metal',
  'plastics',
  'lab',
  'electronics',
];

interface GmailPayloadNode {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadNode[];
}

interface OrderHistoryAggregate {
  key: string;
  vendorId: string;
  vendorName: string;
  name: string;
  sku?: string;
  asin?: string;
  upc?: string;
  imageUrl?: string;
  productUrl?: string;
  packSize?: string;
  quantities: number[];
  unitPrices: number[];
  orderDates: string[];
  avgUnitPrice?: number;
  cadenceDays?: number;
  moq: number;
  recommendedOrderQuantity: number;
  recommendedMinQuantity: number;
  statedLeadTimeDays: number;
  safetyStockDays: number;
}

// ─── Register (Creates Tenant + Admin User) ──────────────────────────
export async function register(input: RegisterInput, auditCtx?: AuthAuditContext): Promise<AuthResponse> {
  const normalizedEmail = input.email.trim().toLowerCase();

  // Check if email already exists across any tenant
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });
  if (existingUser) {
    throw new AppError(409, 'An account with this email already exists', 'EMAIL_EXISTS');
  }

  // Generate slug from company name if not provided
  const slug = input.companySlug || slugify(input.companyName);

  // Check if slug is taken
  const existingTenant = await db.query.tenants.findFirst({
    where: eq(tenants.slug, slug),
  });
  if (existingTenant) {
    throw new AppError(409, 'This company URL is already taken', 'SLUG_EXISTS');
  }

  // Create tenant + user in a transaction
  const result = await db.transaction(async (tx) => {
    // Create tenant
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: input.companyName,
        slug,
        planId: 'free',
        cardLimit: 50,
        seatLimit: 3,
      })
      .returning();

    // Create admin user
    const passwordHash = await hashPassword(input.password);
    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: normalizedEmail,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: 'tenant_admin',
        emailVerified: false,
      })
      .returning();

    // Audit: user registered
    await writeAuthAuditEntry(tx, {
      tenantId: tenant.id,
      action: AuthAuditAction.USER_REGISTERED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      newState: { email: user.email, role: user.role, tenantId: tenant.id },
      metadata: { method: 'password', companyName: input.companyName },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });

    return { tenant, user };
  });

  // Generate tokens
  const tokens = await createTokenPair(result.user.id, result.tenant.id, result.user.email, result.user.role);

  return {
    tokens,
    user: {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      role: result.user.role,
      tenantId: result.tenant.id,
      tenantName: result.tenant.name,
    },
  };
}

// ─── Login ────────────────────────────────────────────────────────────
export async function login(input: LoginInput, auditCtx?: AuthAuditContext): Promise<AuthResponse> {
  const normalizedEmail = input.email.trim().toLowerCase();

  // Find user by email (with tenant data)
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
    with: { tenant: true },
  });

  if (!user || !user.passwordHash) {
    // Audit: login failed — unknown email (no tenant context available)
    // Cannot write audit entry without tenantId; skip audit for unknown accounts.
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    // Audit: login failed — account deactivated
    await writeAuthAuditEntry(db, {
      tenantId: user.tenantId,
      action: AuthAuditAction.USER_LOGIN_FAILED,
      entityType: 'user',
      entityId: user.id,
      userId: null,
      metadata: { email: normalizedEmail, reason: 'account_deactivated' },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });
    throw new AppError(403, 'Account is deactivated', 'ACCOUNT_DEACTIVATED');
  }

  const isValid = await verifyPassword(input.password, user.passwordHash);
  if (!isValid) {
    // Audit: login failed — invalid credentials
    await writeAuthAuditEntry(db, {
      tenantId: user.tenantId,
      action: AuthAuditAction.USER_LOGIN_FAILED,
      entityType: 'user',
      entityId: user.id,
      userId: null,
      metadata: { email: normalizedEmail, reason: 'invalid_credentials' },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  const tokens = await createTokenPair(user.id, user.tenantId, user.email, user.role);

  // Audit: successful login
  await writeAuthAuditEntry(db, {
    tenantId: user.tenantId,
    action: AuthAuditAction.USER_LOGIN,
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    metadata: { method: 'password', email: user.email },
    ipAddress: auditCtx?.ipAddress,
    userAgent: auditCtx?.userAgent,
  });

  return {
    tokens,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
    },
  };
}

// ─── Forgot Password ──────────────────────────────────────────────────
export async function forgotPassword(input: ForgotPasswordInput, auditCtx?: AuthAuditContext): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });

  // Always return success to avoid account enumeration.
  if (!user || !user.isActive) {
    return;
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(resetToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt)
        )
      );

    await tx.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    // Audit: password reset requested
    await writeAuthAuditEntry(tx, {
      tenantId: user.tenantId,
      action: AuthAuditAction.PASSWORD_RESET_REQUESTED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      metadata: { email: user.email },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });
  });

  const appUrl = config.APP_URL.replace(/\/+$/, '');
  const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

  try {
    await sendPasswordResetEmail({
      toEmail: user.email,
      toName: user.firstName,
      resetUrl,
      expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
    });
  } catch (error) {
    console.error('[auth-service] Failed to send password reset email', error);
  }
}

// ─── Reset Password ───────────────────────────────────────────────────
export async function resetPassword(input: ResetPasswordInput, auditCtx?: AuthAuditContext): Promise<void> {
  const tokenHash = hashToken(input.token);
  const resetRecord = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.tokenHash, tokenHash),
      isNull(passwordResetTokens.usedAt)
    ),
  });

  if (!resetRecord) {
    throw new AppError(400, 'Reset link is invalid or already used', 'RESET_TOKEN_INVALID');
  }

  if (resetRecord.expiresAt.getTime() < Date.now()) {
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, resetRecord.id));
    throw new AppError(400, 'Reset link has expired', 'RESET_TOKEN_EXPIRED');
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, resetRecord.userId),
  });

  if (!user || !user.isActive) {
    throw new AppError(400, 'Reset link is invalid', 'RESET_TOKEN_INVALID');
  }

  const nextPasswordHash = await hashPassword(input.newPassword);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: nextPasswordHash,
        emailVerified: true,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt)
        )
      );

    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.userId, user.id),
          isNull(refreshTokens.revokedAt)
        )
      );

    // Audit: password reset completed + tokens revoked
    await writeAuthAuditEntry(tx, {
      tenantId: user.tenantId,
      action: AuthAuditAction.PASSWORD_RESET_COMPLETED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      metadata: { email: user.email, tokensRevoked: true },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });
  });
}

// ─── Refresh Token ────────────────────────────────────────────────────
export async function refreshAccessToken(token: string, auditCtx?: AuthAuditContext): Promise<TokenPair> {
  // Verify the refresh token JWT
  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new AppError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }

  // Find the token record in the database
  const tokenHash = hashToken(token);
  const tokenRecord = await db.query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.tokenHash, tokenHash),
      eq(refreshTokens.userId, payload.sub)
    ),
  });

  if (!tokenRecord) {
    throw new AppError(401, 'Refresh token not found', 'REFRESH_TOKEN_NOT_FOUND');
  }

  // Check if revoked (token rotation detection)
  if (tokenRecord.revokedAt) {
    // Possible token theft — revoke all tokens for this user
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.userId, payload.sub));

    // Audit: token replay detected — security event
    const replayUser = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });
    if (replayUser) {
      await writeAuthAuditEntry(db, {
        tenantId: replayUser.tenantId,
        action: AuthAuditAction.TOKEN_REPLAY_DETECTED,
        entityType: 'token',
        entityId: tokenRecord.id,
        userId: payload.sub,
        metadata: { reason: 'revoked_token_reuse' },
        ipAddress: auditCtx?.ipAddress,
        userAgent: auditCtx?.userAgent,
      });
    }

    throw new AppError(401, 'Refresh token has been revoked', 'REFRESH_TOKEN_REVOKED');
  }

  // Check expiration
  if (new Date() > tokenRecord.expiresAt) {
    throw new AppError(401, 'Refresh token expired', 'REFRESH_TOKEN_EXPIRED');
  }

  // Get user for new access token
  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.sub),
    with: { tenant: true },
  });

  if (!user || !user.isActive) {
    throw new AppError(401, 'User not found or deactivated', 'USER_INVALID');
  }

  // Rotate: revoke old token, create new one
  const newTokens = await db.transaction(async (tx) => {
    // Revoke the old refresh token
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, tokenRecord.id));

    // Create new token pair
    const pair = await createTokenPair(
      user.id,
      user.tenantId,
      user.email,
      user.role,
      tx as unknown as typeof db
    );

    // Audit: token refreshed
    await writeAuthAuditEntry(tx, {
      tenantId: user.tenantId,
      action: AuthAuditAction.TOKEN_REFRESHED,
      entityType: 'token',
      entityId: tokenRecord.id,
      userId: user.id,
      metadata: { method: 'refresh' },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });

    return pair;
  });

  return newTokens;
}

// ─── Google ID Token Verification ────────────────────────────────────
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleOAuthProfile> {
  if (!config.GOOGLE_CLIENT_ID) {
    throw new AppError(500, 'Google OAuth is not configured (missing GOOGLE_CLIENT_ID)', 'GOOGLE_NOT_CONFIGURED');
  }

  const client = new OAuth2Client(config.GOOGLE_CLIENT_ID);
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      throw new AppError(401, 'Invalid Google ID token payload', 'INVALID_GOOGLE_TOKEN');
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      firstName: payload.given_name || '',
      lastName: payload.family_name || '',
      avatarUrl: payload.picture,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'Failed to verify Google ID token', 'INVALID_GOOGLE_TOKEN');
  }
}

// ─── Google OAuth Callback ────────────────────────────────────────────
export async function handleGoogleOAuth(profile: {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
}, auditCtx?: AuthAuditContext): Promise<AuthResponse> {
  // Check if there's an existing OAuth account
  const existingOAuth = await db.query.oauthAccounts.findFirst({
    where: and(
      eq(oauthAccounts.provider, 'google'),
      eq(oauthAccounts.providerAccountId, profile.googleId)
    ),
    with: { user: { with: { tenant: true } } },
  });

  if (existingOAuth) {
    // Existing user — log them in
    const user = existingOAuth.user;
    if (!user.isActive) {
      // Audit: Google login failed — account deactivated
      await writeAuthAuditEntry(db, {
        tenantId: user.tenantId,
        action: AuthAuditAction.USER_LOGIN_FAILED,
        entityType: 'user',
        entityId: user.id,
        userId: null,
        metadata: { email: user.email, method: 'google', reason: 'account_deactivated' },
        ipAddress: auditCtx?.ipAddress,
        userAgent: auditCtx?.userAgent,
      });
      throw new AppError(403, 'Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const tokens = await createTokenPair(user.id, user.tenantId, user.email, user.role);

    // Audit: Google OAuth login (existing account)
    await writeAuthAuditEntry(db, {
      tenantId: user.tenantId,
      action: AuthAuditAction.OAUTH_GOOGLE_LOGIN,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      metadata: { method: 'google', email: user.email },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });

    return {
      tokens,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
      },
    };
  }

  // Check if email exists (link OAuth to existing account)
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, profile.email),
    with: { tenant: true },
  });

  if (existingUser) {
    // Link OAuth to existing account
    await db.insert(oauthAccounts).values({
      userId: existingUser.id,
      provider: 'google',
      providerAccountId: profile.googleId,
    });

    const tokens = await createTokenPair(
      existingUser.id,
      existingUser.tenantId,
      existingUser.email,
      existingUser.role
    );

    // Audit: Google OAuth linked to existing account + login
    await writeAuthAuditEntry(db, {
      tenantId: existingUser.tenantId,
      action: AuthAuditAction.OAUTH_GOOGLE_LINKED,
      entityType: 'user',
      entityId: existingUser.id,
      userId: existingUser.id,
      metadata: { method: 'google', email: existingUser.email, autoLinked: true },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });

    return {
      tokens,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        role: existingUser.role,
        tenantId: existingUser.tenantId,
        tenantName: existingUser.tenant.name,
      },
    };
  }

  // Brand new user — create tenant + user + OAuth link
  const slug = slugify(profile.email.split('@')[0] + '-co');
  const result = await db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: `${profile.firstName}'s Company`,
        slug,
        planId: 'free',
        cardLimit: 50,
        seatLimit: 3,
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarUrl: profile.avatarUrl,
        role: 'tenant_admin',
        emailVerified: true, // Google-verified
      })
      .returning();

    await tx.insert(oauthAccounts).values({
      userId: user.id,
      provider: 'google',
      providerAccountId: profile.googleId,
    });

    // Audit: new user registered via Google OAuth
    await writeAuthAuditEntry(tx, {
      tenantId: tenant.id,
      action: AuthAuditAction.OAUTH_GOOGLE_REGISTERED,
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      newState: { email: user.email, role: user.role, tenantId: tenant.id },
      metadata: { method: 'google', companyName: tenant.name },
      ipAddress: auditCtx?.ipAddress,
      userAgent: auditCtx?.userAgent,
    });

    return { tenant, user };
  });

  const tokens = await createTokenPair(
    result.user.id,
    result.tenant.id,
    result.user.email,
    result.user.role
  );

  return {
    tokens,
    user: {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      role: result.user.role,
      tenantId: result.tenant.id,
      tenantName: result.tenant.name,
    },
  };
}

export function generateGoogleOAuthAuthorizationUrl(input: {
  state: string;
  redirectUri: string;
}): string {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      500,
      'Google OAuth is not configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)',
      'GOOGLE_NOT_CONFIGURED',
    );
  }

  const client = new OAuth2Client(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    input.redirectUri,
  );

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: input.state,
  });
}

export async function exchangeGoogleOAuthCode(input: {
  code: string;
  redirectUri: string;
}): Promise<{ profile: GoogleOAuthProfile; tokens: GoogleOAuthTokenBundle }> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      500,
      'Google OAuth is not configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)',
      'GOOGLE_NOT_CONFIGURED',
    );
  }

  const client = new OAuth2Client(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    input.redirectUri,
  );

  let tokenResponse;
  try {
    tokenResponse = await client.getToken(input.code);
  } catch {
    throw new AppError(401, 'Unable to exchange Google OAuth code', 'GOOGLE_CODE_EXCHANGE_FAILED');
  }

  const accessToken = tokenResponse.tokens.access_token;
  if (!accessToken) {
    throw new AppError(401, 'Google OAuth did not return an access token', 'GOOGLE_ACCESS_TOKEN_MISSING');
  }

  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!userInfoResponse.ok) {
    throw new AppError(401, 'Unable to fetch Google user profile', 'GOOGLE_USERINFO_FAILED');
  }

  const userInfo = (await userInfoResponse.json()) as {
    id?: string;
    email?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
  };
  if (!userInfo.id || !userInfo.email) {
    throw new AppError(401, 'Google user profile missing required fields', 'GOOGLE_USERINFO_INVALID');
  }

  return {
    profile: {
      googleId: userInfo.id,
      email: userInfo.email,
      firstName: userInfo.given_name || '',
      lastName: userInfo.family_name || '',
      avatarUrl: userInfo.picture,
    },
    tokens: {
      accessToken,
      refreshToken: tokenResponse.tokens.refresh_token ?? undefined,
      expiresAt: tokenResponse.tokens.expiry_date
        ? new Date(tokenResponse.tokens.expiry_date)
        : undefined,
    },
  };
}

export async function linkGoogleOAuthForUser(input: {
  userId: string;
  profile: GoogleOAuthProfile;
  tokens: GoogleOAuthTokenBundle;
}): Promise<void> {
  const [existingForGoogleId, existingForUser] = await Promise.all([
    db.query.oauthAccounts.findFirst({
      where: and(
        eq(oauthAccounts.provider, 'google'),
        eq(oauthAccounts.providerAccountId, input.profile.googleId),
      ),
    }),
    db.query.oauthAccounts.findFirst({
      where: and(eq(oauthAccounts.provider, 'google'), eq(oauthAccounts.userId, input.userId)),
    }),
  ]);

  if (existingForGoogleId && existingForGoogleId.userId !== input.userId) {
    throw new AppError(409, 'This Google account is linked to another workspace user', 'GOOGLE_ALREADY_LINKED');
  }

  const targetRecord = existingForGoogleId || existingForUser;
  const nextAccessToken =
    input.tokens.accessToken ?? targetRecord?.accessToken ?? undefined;
  const nextRefreshToken =
    input.tokens.refreshToken ?? targetRecord?.refreshToken ?? undefined;
  const nextExpiresAt = input.tokens.expiresAt ?? targetRecord?.expiresAt ?? null;

  if (targetRecord) {
    await db
      .update(oauthAccounts)
      .set({
        providerAccountId: input.profile.googleId,
        accessToken: nextAccessToken ?? null,
        refreshToken: nextRefreshToken ?? null,
        expiresAt: nextExpiresAt,
      })
      .where(eq(oauthAccounts.id, targetRecord.id));
    return;
  }

  await db.insert(oauthAccounts).values({
    userId: input.userId,
    provider: 'google',
    providerAccountId: input.profile.googleId,
    accessToken: nextAccessToken ?? null,
    refreshToken: nextRefreshToken ?? null,
    expiresAt: nextExpiresAt,
  });
}

async function getValidGoogleAccessTokenForUser(userId: string): Promise<string> {
  const account = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.provider, 'google'), eq(oauthAccounts.userId, userId)),
  });

  if (!account) {
    throw new AppError(404, 'No Gmail account is linked to this user.', 'GOOGLE_NOT_LINKED');
  }

  const expiresSoon =
    !!account.expiresAt && account.expiresAt.getTime() <= Date.now() + 5 * 60 * 1000;
  if (account.accessToken && !expiresSoon) {
    return account.accessToken;
  }

  if (!account.refreshToken) {
    throw new AppError(401, 'Google OAuth token expired. Reconnect Gmail.', 'GOOGLE_REAUTH_REQUIRED');
  }

  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      500,
      'Google OAuth is not configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)',
      'GOOGLE_NOT_CONFIGURED',
    );
  }

  try {
    const oauth2Client = new OAuth2Client(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: account.refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    const nextAccessToken = credentials.access_token ?? account.accessToken;
    if (!nextAccessToken) {
      throw new AppError(401, 'Google OAuth refresh failed. Reconnect Gmail.', 'GOOGLE_REAUTH_REQUIRED');
    }

    await db
      .update(oauthAccounts)
      .set({
        accessToken: nextAccessToken,
        refreshToken: credentials.refresh_token ?? account.refreshToken,
        expiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : account.expiresAt,
      })
      .where(eq(oauthAccounts.id, account.id));

    return nextAccessToken;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'Google OAuth refresh failed. Reconnect Gmail.', 'GOOGLE_REAUTH_REQUIRED');
  }
}

function sanitizeLookbackDays(value?: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : GMAIL_LOOKBACK_DAYS_DEFAULT;
  return Math.max(GMAIL_LOOKBACK_DAYS_MIN, Math.min(GMAIL_LOOKBACK_DAYS_MAX, numeric));
}

function normalizeHostDomain(rawDomain: string): string {
  return rawDomain.trim().toLowerCase().replace(/^www\./, '');
}

function domainMatchesTarget(domain: string, targetDomain: string): boolean {
  const normalizedDomain = normalizeHostDomain(domain);
  const normalizedTarget = normalizeHostDomain(targetDomain);
  return (
    normalizedDomain === normalizedTarget ||
    normalizedDomain.endsWith(`.${normalizedTarget}`)
  );
}

function resolveKnownVendorByDomain(domain: string): KnownVendorDefinition | null {
  const normalized = normalizeHostDomain(domain);
  for (const vendor of KNOWN_VENDORS) {
    if (vendor.domains.some((candidate) => domainMatchesTarget(normalized, candidate))) {
      return vendor;
    }
  }
  return null;
}

function extractRawEmailDomain(fromHeader: string): string | null {
  const emailMatch = fromHeader.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (!emailMatch?.[1]) return null;
  const normalized = normalizeHostDomain(emailMatch[1]);
  return normalized || null;
}

function isDiscoveryAllowedDomain(domain: string): boolean {
  const normalized = normalizeHostDomain(domain);
  return Boolean(normalized) && !GMAIL_DISCOVERY_DOMAIN_DENYLIST.has(normalized);
}

function extractSenderName(fromHeader: string): string | null {
  const nameOnly = fromHeader.split('<')[0]?.trim().replace(/^"+|"+$/g, '');
  if (nameOnly && !nameOnly.includes('@')) return nameOnly;
  return null;
}

function formatVendorNameFromDomain(domain: string): string {
  const base = domain.split('.')[0] || domain;
  return base
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeGmailBodyData(data?: string): string {
  if (!data) return '';
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(br|p|div|li|tr|td|th|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBodyTextFromPayload(payload?: GmailPayloadNode): string {
  if (!payload) return '';

  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  const walk = (node?: GmailPayloadNode) => {
    if (!node) return;
    const mimeType = (node.mimeType || '').toLowerCase();
    const text = decodeGmailBodyData(node.body?.data);
    if (text) {
      if (mimeType.includes('text/plain')) plainParts.push(text);
      if (mimeType.includes('text/html')) htmlParts.push(text);
    }
    if (Array.isArray(node.parts)) {
      for (const part of node.parts) {
        walk(part);
      }
    }
  };

  walk(payload);

  const plain = normalizeWhitespace(plainParts.join('\n'));
  if (plain) return plain.slice(0, 24_000);

  const html = normalizeWhitespace(stripHtml(htmlParts.join('\n')));
  return html.slice(0, 24_000);
}

function domainContainsAny(domain: string, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (domainMatchesTarget(domain, candidate)) return true;
  }
  return false;
}

function domainInSet(domain: string, domainSet: Set<string>): boolean {
  for (const candidate of domainSet) {
    if (domainMatchesTarget(domain, candidate)) return true;
  }
  return false;
}

function isLikelyFinancialInstitution(input: {
  domain: string;
  senderName?: string;
  subject?: string;
}): boolean {
  const domain = normalizeHostDomain(input.domain);
  if (!domain) return true;
  if (domainContainsAny(domain, FINANCIAL_DOMAIN_DENYLIST)) return true;

  const combined = `${input.senderName || ''} ${input.subject || ''}`.toLowerCase();
  if (!combined) return false;
  return /\b(bank|credit union|financial|brokerage|mortgage|loan|lending|wealth|retirement|billing statement)\b/i.test(
    combined,
  );
}

function isLikelyIndustrialSupplier(input: {
  domain: string;
  vendorName: string;
  selectedVendorDomains?: Set<string>;
}): boolean {
  const domain = normalizeHostDomain(input.domain);
  if (!domain) return false;

  const known = resolveKnownVendorByDomain(domain);
  if (known) {
    return INDUSTRIAL_VENDOR_IDS.has(known.id);
  }

  if (input.selectedVendorDomains?.size) {
    for (const candidate of input.selectedVendorDomains) {
      if (domainMatchesTarget(domain, candidate)) return true;
    }
  }

  const haystack = `${domain} ${input.vendorName}`.toLowerCase();
  return INDUSTRIAL_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function classifyPurchaseMessageType(text: string): PurchaseMessageType | null {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return null;

  const matches = (patterns: RegExp[]) =>
    patterns.reduce((count, pattern) => count + (pattern.test(normalized) ? 1 : 0), 0);

  const receiptScore = matches(RECEIPT_PATTERNS);
  const shippingScore = matches(SHIPPING_PATTERNS);
  const deliveryScore = matches(DELIVERY_PATTERNS);
  const bestScore = Math.max(receiptScore, shippingScore, deliveryScore);
  if (bestScore <= 0) return null;
  if (deliveryScore === bestScore) return 'delivery';
  if (shippingScore === bestScore) return 'shipping';
  return 'receipt';
}

function shouldExcludeMessageByContent(input: {
  labels?: string[];
  subject: string;
  snippet: string;
  bodyText: string;
}): boolean {
  const labels = new Set((input.labels || []).map((label) => label.toUpperCase()));
  if (
    labels.has('CATEGORY_PROMOTIONS') ||
    labels.has('CATEGORY_FORUMS') ||
    labels.has('CATEGORY_SOCIAL')
  ) {
    return true;
  }

  const haystack = `${input.subject}\n${input.snippet}\n${input.bodyText}`.slice(0, 20_000);
  return NEGATIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(haystack));
}

function buildGmailQuery(input: {
  lookbackDays: number;
  domainClause?: string;
}): string {
  const clauses = [
    `newer_than:${sanitizeLookbackDays(input.lookbackDays)}d`,
    GMAIL_PURCHASE_QUERY_CLAUSE,
  ];

  if (input.domainClause) {
    clauses.push(input.domainClause);
  }

  return clauses.join(' ');
}

function domainClauseForDomains(domains: string[]): string | undefined {
  const normalized = Array.from(
    new Set(
      domains
        .map((domain) => normalizeHostDomain(domain))
        .filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
        .filter(isDiscoveryAllowedDomain),
    ),
  );
  if (normalized.length === 0) return undefined;
  return `(${normalized.map((domain) => `from:${domain}`).join(' OR ')})`;
}

async function listGmailMessageIds(input: {
  accessToken: string;
  query: string;
  maxResults: number;
}): Promise<{ ids: string[]; hasMore: boolean }> {
  const safeMax = Math.max(1, Math.min(250, Math.trunc(input.maxResults)));
  const listParams = new URLSearchParams({
    maxResults: String(safeMax),
    q: input.query,
  });

  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`,
    {
      headers: { Authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!listResponse.ok) {
    throw new AppError(502, 'Failed to read Gmail messages.', 'GMAIL_FETCH_FAILED');
  }

  const listPayload = (await listResponse.json()) as {
    messages?: Array<{ id?: string | null }>;
    nextPageToken?: string;
  };
  const ids = (listPayload.messages || [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id));

  return {
    ids,
    hasMore: Boolean(listPayload.nextPageToken),
  };
}

function domainsForVendorIds(vendorIds?: string[]): string[] {
  if (!vendorIds?.length) return [];
  const domains: string[] = [];

  for (const vendorId of vendorIds) {
    const normalizedVendorId = vendorId.trim().toLowerCase();
    if (!normalizedVendorId) continue;

    const known = KNOWN_VENDOR_BY_ID.get(normalizedVendorId);
    if (known) {
      domains.push(...known.domains);
      continue;
    }

    if (normalizedVendorId.startsWith('gmail-')) {
      const maybeDomain = normalizedVendorId.slice('gmail-'.length).replace(/-/g, '.');
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(maybeDomain)) {
        domains.push(maybeDomain);
      }
    }
  }

  return Array.from(new Set(domains.map((domain) => normalizeHostDomain(domain))));
}

function extractUrlsFromText(text: string): string[] {
  const regex = /https?:\/\/[^\s<>"')]+/gi;
  const matches = text.match(regex);
  if (!matches) return [];
  return matches
    .map((match) => match.trim().replace(/[),.;!?]+$/, ''))
    .filter((url) => url.startsWith('http://') || url.startsWith('https://'));
}

function extractDomainsFromText(text: string): string[] {
  const domains = new Set<string>();
  for (const url of extractUrlsFromText(text)) {
    try {
      const parsed = new URL(url);
      const normalized = normalizeHostDomain(parsed.hostname);
      if (normalized) domains.add(normalized);
    } catch {
      // ignore malformed URLs in snippets
    }
  }
  return Array.from(domains);
}

function choosePreferredDomain(input: {
  candidateDomains: string[];
  preferredDomains?: Set<string>;
}): string | null {
  const unique = Array.from(
    new Set(
      input.candidateDomains
        .map((domain) => normalizeHostDomain(domain))
        .filter(isDiscoveryAllowedDomain),
    ),
  );
  if (unique.length === 0) return null;

  if (input.preferredDomains?.size) {
    const preferredMatch = unique.find((domain) => input.preferredDomains!.has(domain));
    if (preferredMatch) return preferredMatch;
  }

  const knownMatch = unique
    .map((domain) => ({ domain, known: resolveKnownVendorByDomain(domain) }))
    .filter((entry) => entry.known)
    .sort((a, b) => (a.known!.priority - b.known!.priority))
    .map((entry) => entry.domain)[0];
  if (knownMatch) return knownMatch;

  return unique[0];
}

function toVendorId(input: { domain?: string | null; vendorName?: string | null }): string {
  const domain = input.domain?.trim().toLowerCase().replace(/^www\./, '') || '';
  if (domain) {
    const known = resolveKnownVendorByDomain(domain);
    if (known) return known.id;
    return `gmail-${domain.replace(/[^a-z0-9]+/g, '-')}`;
  }
  const fallbackName = (input.vendorName || 'vendor').toLowerCase();
  return `gmail-${fallbackName.replace(/[^a-z0-9]+/g, '-')}`;
}

export async function discoverGmailSuppliersForUser(input: {
  userId: string;
  maxResults?: number;
  lookbackDays?: number;
}): Promise<GmailSupplierDiscoveryResult> {
  const accessToken = await getValidGoogleAccessTokenForUser(input.userId);
  const cappedResults = Math.max(20, Math.min(input.maxResults ?? 120, 250));
  const lookbackDays = sanitizeLookbackDays(input.lookbackDays);
  const amazonDomains = KNOWN_VENDORS
    .filter((vendor) => AMAZON_VENDOR_IDS.has(vendor.id))
    .flatMap((vendor) => vendor.domains);
  const industrialDomains = KNOWN_VENDORS
    .filter((vendor) => INDUSTRIAL_VENDOR_IDS.has(vendor.id))
    .flatMap((vendor) => vendor.domains);

  const stagedDomainClauses = [
    domainClauseForDomains(amazonDomains),
    domainClauseForDomains(industrialDomains),
    undefined,
  ];

  const messageIdSet = new Set<string>();
  let hasMore = false;

  for (const domainClause of stagedDomainClauses) {
    const remaining = cappedResults - messageIdSet.size;
    if (remaining <= 0) break;

    const query = buildGmailQuery({
      lookbackDays,
      domainClause,
    });
    const idsResult = await listGmailMessageIds({
      accessToken,
      query,
      maxResults: remaining,
    });
    hasMore = hasMore || idsResult.hasMore;
    for (const id of idsResult.ids) {
      messageIdSet.add(id);
    }
  }

  const messages = Array.from(messageIdSet).slice(0, cappedResults);

  if (messages.length === 0) {
    return {
      suppliers: [],
      scannedMessages: 0,
      hasMore,
    };
  }

  const supplierByDomain = new Map<
    string,
    {
      vendorName: string;
      messageCount: number;
      lastSeenEpochMs: number;
    }
  >();

  await Promise.all(
    messages.map(async (messageId) => {
      const messageParams = new URLSearchParams();
      messageParams.set('format', 'metadata');
      messageParams.append('metadataHeaders', 'From');
      messageParams.append('metadataHeaders', 'Date');
      messageParams.append('metadataHeaders', 'Subject');

      const messageResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?${messageParams.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (!messageResponse.ok) {
        return;
      }

      const payload = (await messageResponse.json()) as {
        internalDate?: string;
        snippet?: string;
        payload?: { headers?: Array<{ name?: string; value?: string }> };
      };
      const headers = payload.payload?.headers || [];
      const fromHeader =
        headers.find((header) => header.name?.toLowerCase() === 'from')?.value || '';
      const subjectHeader =
        headers.find((header) => header.name?.toLowerCase() === 'subject')?.value || '';
      const snippet = payload.snippet || '';
      const textDomains = extractDomainsFromText(`${subjectHeader}\n${snippet}`);
      const fromDomain = fromHeader ? extractRawEmailDomain(fromHeader) : null;
      const domain = choosePreferredDomain({
        candidateDomains: [
          ...(fromDomain ? [fromDomain] : []),
          ...textDomains,
        ],
      });
      if (!domain) return;
      const knownVendor = resolveKnownVendorByDomain(domain);
      const senderName = extractSenderName(fromHeader) || undefined;
      const resolvedVendorName = knownVendor?.name || senderName || formatVendorNameFromDomain(domain);

      if (
        shouldExcludeMessageByContent({
          subject: subjectHeader,
          snippet,
          bodyText: '',
        })
      ) {
        return;
      }

      if (isLikelyFinancialInstitution({ domain, senderName, subject: subjectHeader })) {
        return;
      }

      if (!isLikelyIndustrialSupplier({ domain, vendorName: resolvedVendorName })) {
        return;
      }

      if (!classifyPurchaseMessageType(`${subjectHeader}\n${snippet}`)) {
        return;
      }

      const dateHeader =
        headers.find((header) => header.name?.toLowerCase() === 'date')?.value || '';
      const parsedDate = Date.parse(dateHeader);
      const internalDateEpochMs = Number(payload.internalDate || 0);
      const lastSeenEpochMs = Number.isFinite(parsedDate) && parsedDate > 0
        ? parsedDate
        : internalDateEpochMs > 0
          ? internalDateEpochMs
          : Date.now();

      const current = supplierByDomain.get(domain);

      if (!current) {
        supplierByDomain.set(domain, {
          vendorName: resolvedVendorName,
          messageCount: 1,
          lastSeenEpochMs,
        });
        return;
      }

      current.messageCount += 1;
      current.lastSeenEpochMs = Math.max(current.lastSeenEpochMs, lastSeenEpochMs);
      if (!senderName) return;
      if (knownVendor) {
        current.vendorName = knownVendor.name;
      } else if (current.vendorName === formatVendorNameFromDomain(domain)) {
        current.vendorName = senderName;
      }
    }),
  );

  const suppliers: GmailDiscoveredSupplier[] = Array.from(supplierByDomain.entries())
    .map(([domain, aggregate]) => ({
      vendorId: toVendorId({ domain, vendorName: aggregate.vendorName }),
      vendorName: resolveKnownVendorByDomain(domain)?.name || aggregate.vendorName,
      domain: normalizeHostDomain(domain),
      messageCount: aggregate.messageCount,
      lastSeenAt: new Date(aggregate.lastSeenEpochMs).toISOString(),
    }))
    .sort((a, b) => {
      const aPriority = resolveKnownVendorByDomain(a.domain)?.priority ?? 9;
      const bPriority = resolveKnownVendorByDomain(b.domain)?.priority ?? 9;
      if (aPriority !== bPriority) return aPriority - bPriority;
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });

  return {
    suppliers,
    scannedMessages: messages.length,
    hasMore,
  };
}

interface GmailMessageSignal {
  id: string;
  from: string;
  domain: string;
  vendorName: string;
  subject: string;
  snippet: string;
  bodyText: string;
  messageType: PurchaseMessageType;
  receivedAt: string;
  receivedEpochMs: number;
}

interface OpenAiChatCompletionPayload {
  error?: { message?: string };
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
}

function normalizeIsoTimestamp(value: unknown, fallbackIso = new Date().toISOString()): string {
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallbackIso;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toConfidencePercent(value: unknown, fallback = 60): number {
  const numeric = toNumber(value);
  if (numeric === null) return fallback;
  if (numeric <= 1) return Math.max(1, Math.min(100, Math.round(numeric * 100)));
  return Math.max(1, Math.min(100, Math.round(numeric)));
}

function toConfidenceUnit(value: unknown, fallback = 0.7): number {
  const numeric = toNumber(value);
  if (numeric === null) return fallback;
  if (numeric > 1) return Math.max(0.01, Math.min(1, numeric / 100));
  return Math.max(0.01, Math.min(1, numeric));
}

function toPositiveInt(value: unknown, fallback = 1): number {
  const numeric = toNumber(value);
  if (numeric === null) return fallback;
  return Math.max(1, Math.round(numeric));
}

function maybeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDomain(value: unknown): string | undefined {
  const raw = maybeString(value);
  if (!raw) return undefined;
  const normalized = raw
    .toLowerCase()
    .replace(/^mailto:/, '')
    .replace(/^www\./, '')
    .trim();

  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function extractOrderNumber(subject: string, snippet: string): string | null {
  const haystack = `${subject} ${snippet}`;
  const pattern =
    /(?:order|po|purchase order|invoice|receipt|confirmation)[^\w]{0,8}([A-Z0-9][A-Z0-9-]{3,})/i;
  const match = haystack.match(pattern);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function normalizeOpenAiBaseUrl(): string {
  return config.OPENAI_BASE_URL.replace(/\/+$/, '');
}

function isOpenAiConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY?.trim());
}

function extractOpenAiContentText(
  content:
    | string
    | Array<{
        type?: string;
        text?: string;
      }>
    | undefined,
): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
  return text || null;
}

function parseJsonFromModelOutput(rawContent: string): Record<string, unknown> {
  const fenced = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || rawContent).trim();

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to bracket extraction.
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // no-op, handled below
    }
  }

  throw new AppError(502, 'AI provider returned non-JSON output.', 'AI_INVALID_RESPONSE');
}

async function callOpenAiChatCompletionJson(input: {
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
  temperature?: number;
}): Promise<Record<string, unknown>> {
  if (!isOpenAiConfigured()) {
    throw new AppError(
      503,
      'AI analysis is not configured (missing OPENAI_API_KEY).',
      'AI_NOT_CONFIGURED',
    );
  }

  const response = await fetch(`${normalizeOpenAiBaseUrl()}${OPENAI_COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      temperature: input.temperature ?? 0.2,
      response_format: { type: 'json_object' },
      messages: input.messages,
      max_tokens: input.maxTokens ?? 1800,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const payload = (await response.json()) as OpenAiChatCompletionPayload;
  if (!response.ok) {
    throw new AppError(
      502,
      payload.error?.message || 'AI provider request failed.',
      'AI_REQUEST_FAILED',
    );
  }

  const content = extractOpenAiContentText(payload.choices?.[0]?.message?.content);
  if (!content) {
    throw new AppError(502, 'AI provider returned an empty response.', 'AI_EMPTY_RESPONSE');
  }

  return parseJsonFromModelOutput(content);
}

async function fetchGmailMessageSignalsForUser(input: {
  userId: string;
  maxResults?: number;
  lookbackDays?: number;
  vendorIds?: string[];
}): Promise<{ signals: GmailMessageSignal[]; hasMore: boolean }> {
  const accessToken = await getValidGoogleAccessTokenForUser(input.userId);
  const cappedResults = Math.max(20, Math.min(input.maxResults ?? 120, 250));
  const lookbackDays = sanitizeLookbackDays(input.lookbackDays);
  const selectedVendorDomains = domainsForVendorIds(input.vendorIds);
  const selectedVendorDomainSet = new Set(selectedVendorDomains);

  const amazonDomains = KNOWN_VENDORS
    .filter((vendor) => AMAZON_VENDOR_IDS.has(vendor.id))
    .flatMap((vendor) => vendor.domains);
  const industrialDomains = KNOWN_VENDORS
    .filter((vendor) => INDUSTRIAL_VENDOR_IDS.has(vendor.id))
    .flatMap((vendor) => vendor.domains);

  const stagedDomainClauses = [
    selectedVendorDomains.length > 0 ? domainClauseForDomains(selectedVendorDomains) : undefined,
    domainClauseForDomains(industrialDomains),
    domainClauseForDomains(amazonDomains),
    undefined,
  ];

  const messageIdSet = new Set<string>();
  const seenQueries = new Set<string>();
  let hasMore = false;

  for (const domainClause of stagedDomainClauses) {
    const remaining = cappedResults - messageIdSet.size;
    if (remaining <= 0) break;

    const query = buildGmailQuery({
      lookbackDays,
      domainClause,
    });
    if (seenQueries.has(query)) continue;
    seenQueries.add(query);

    const idsResult = await listGmailMessageIds({
      accessToken,
      query,
      maxResults: remaining,
    });
    hasMore = hasMore || idsResult.hasMore;
    for (const id of idsResult.ids) {
      messageIdSet.add(id);
    }
  }

  const messageIds = Array.from(messageIdSet).slice(0, cappedResults);

  if (messageIds.length === 0) {
    return {
      signals: [],
      hasMore,
    };
  }

  const messageSignals: GmailMessageSignal[] = [];
  const batchSize = 8;

  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (messageId) => {
        const messageParams = new URLSearchParams();
        messageParams.set('format', 'full');

        const response = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?${messageParams.toString()}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!response.ok) return null;

        const payload = (await response.json()) as {
          internalDate?: string;
          labelIds?: string[];
          snippet?: string;
          payload?: GmailPayloadNode & { headers?: Array<{ name?: string; value?: string }> };
        };
        const headers = payload.payload?.headers || [];

        const fromHeader =
          headers.find((header) => header.name?.toLowerCase() === 'from')?.value || '';

        const dateHeader =
          headers.find((header) => header.name?.toLowerCase() === 'date')?.value || '';
        const subjectHeader =
          headers.find((header) => header.name?.toLowerCase() === 'subject')?.value || '';
        const snippet = payload.snippet || '';
        const bodyText = extractBodyTextFromPayload(payload.payload);
        if (
          shouldExcludeMessageByContent({
            labels: payload.labelIds,
            subject: subjectHeader,
            snippet,
            bodyText,
          })
        ) {
          return null;
        }

        const senderName = extractSenderName(fromHeader) || undefined;
        const fromDomain = fromHeader ? extractRawEmailDomain(fromHeader) : null;
        const urlDomains = extractDomainsFromText(`${subjectHeader}\n${snippet}\n${bodyText.slice(0, 8_000)}`);
        const domain = choosePreferredDomain({
          candidateDomains: [
            ...(fromDomain ? [fromDomain] : []),
            ...urlDomains,
          ],
          preferredDomains: selectedVendorDomainSet.size > 0 ? selectedVendorDomainSet : undefined,
        });
        if (!domain) return null;

        if (selectedVendorDomainSet.size > 0 && !domainInSet(domain, selectedVendorDomainSet)) {
          return null;
        }

        if (isLikelyFinancialInstitution({ domain, senderName, subject: subjectHeader })) {
          return null;
        }

        const knownVendor = resolveKnownVendorByDomain(domain);
        const vendorName =
          knownVendor?.name ||
          extractSenderName(fromHeader) ||
          formatVendorNameFromDomain(domain);

        if (
          !isLikelyIndustrialSupplier({
            domain,
            vendorName,
            selectedVendorDomains: selectedVendorDomainSet,
          })
        ) {
          return null;
        }

        const messageType = classifyPurchaseMessageType(
          `${subjectHeader}\n${snippet}\n${bodyText.slice(0, 12_000)}`,
        );
        if (!messageType) return null;

        const parsedDate = Date.parse(dateHeader);
        const internalDateEpochMs = Number(payload.internalDate || 0);
        const receivedEpochMs = Number.isFinite(parsedDate) && parsedDate > 0
          ? parsedDate
          : internalDateEpochMs > 0
            ? internalDateEpochMs
            : Date.now();
        const receivedAt = new Date(receivedEpochMs).toISOString();

        return {
          id: messageId,
          from: fromHeader,
          domain,
          vendorName,
          subject: subjectHeader || '(No subject)',
          snippet,
          bodyText,
          messageType,
          receivedAt,
          receivedEpochMs,
        } satisfies GmailMessageSignal;
      }),
    );

    for (const result of batchResults) {
      if (result) {
        messageSignals.push(result);
      }
    }
  }

  return {
    signals: messageSignals,
    hasMore,
  };
}

function aggregateSuppliersFromSignals(signals: GmailMessageSignal[]): GmailDiscoveredSupplier[] {
  const supplierByDomain = new Map<
    string,
    {
      vendorName: string;
      messageCount: number;
      lastSeenEpochMs: number;
    }
  >();

  for (const signal of signals) {
    const current = supplierByDomain.get(signal.domain);
    if (!current) {
      supplierByDomain.set(signal.domain, {
        vendorName: signal.vendorName,
        messageCount: 1,
        lastSeenEpochMs: signal.receivedEpochMs,
      });
      continue;
    }
    current.messageCount += 1;
    current.lastSeenEpochMs = Math.max(current.lastSeenEpochMs, signal.receivedEpochMs);
    if (current.vendorName === formatVendorNameFromDomain(signal.domain) && signal.vendorName) {
      current.vendorName = signal.vendorName;
    }
  }

  return Array.from(supplierByDomain.entries())
    .map(([domain, aggregate]) => ({
      vendorId: toVendorId({ domain }),
      vendorName: resolveKnownVendorByDomain(domain)?.name || aggregate.vendorName,
      domain,
      messageCount: aggregate.messageCount,
      lastSeenAt: new Date(aggregate.lastSeenEpochMs).toISOString(),
    }))
    .sort((a, b) => {
      const aPriority = resolveKnownVendorByDomain(a.domain)?.priority ?? 9;
      const bPriority = resolveKnownVendorByDomain(b.domain)?.priority ?? 9;
      if (aPriority !== bPriority) return aPriority - bPriority;
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    });
}

function extractAmazonAsinFromUrl(url: string): string | undefined {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:[&#]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return undefined;
}

function inferSkuFromIndustrialPath(url: URL): string | undefined {
  const segments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  const tail = segments[segments.length - 1] || segments[segments.length - 2];
  if (!tail) return undefined;
  const normalized = tail.replace(/[^A-Za-z0-9._-]/g, '').toUpperCase();
  if (normalized.length < 3 || normalized.length > 40) return undefined;
  return normalized;
}

function enrichItemViaVendorUrlRules(
  item: GmailDetectedOrderItem,
  fallbackDomain?: string,
): GmailDetectedOrderItem {
  if (!item.url) return item;

  try {
    const parsed = new URL(item.url);
    const domain = normalizeHostDomain(parsed.hostname);
    const effectiveDomain = domain || fallbackDomain || '';
    const knownVendor = resolveKnownVendorByDomain(effectiveDomain);
    if (!knownVendor) return item;

    const enriched: GmailDetectedOrderItem = { ...item };
    enriched.url = parsed.toString();

    if (knownVendor.id === 'amazon') {
      const asin = extractAmazonAsinFromUrl(parsed.toString());
      if (asin && !enriched.asin) enriched.asin = asin;
      if (asin && !enriched.sku) enriched.sku = asin;
      if (asin) enriched.url = `https://www.amazon.com/dp/${asin}`;
      return enriched;
    }

    if (!enriched.sku) {
      const inferredSku = inferSkuFromIndustrialPath(parsed);
      if (inferredSku) enriched.sku = inferredSku;
    }

    return enriched;
  } catch {
    return item;
  }
}

function extractPreferredUrlFromSignal(signal: GmailMessageSignal): string | undefined {
  const urls = extractUrlsFromText(`${signal.subject}\n${signal.snippet}\n${signal.bodyText}`);
  if (urls.length === 0) return undefined;

  const sameVendor = urls.find((url) => {
    try {
      const domain = normalizeHostDomain(new URL(url).hostname);
      return domainMatchesTarget(domain, signal.domain);
    } catch {
      return false;
    }
  });
  return sameVendor || urls[0];
}

function extractImageUrlFromText(text: string, signal: GmailMessageSignal): string | undefined {
  const urls = extractUrlsFromText(text);
  const imageUrl = urls.find((url) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url));
  if (imageUrl) return imageUrl;

  const sameVendor = urls.find((url) => {
    try {
      const domain = normalizeHostDomain(new URL(url).hostname);
      return domainMatchesTarget(domain, signal.domain) && /image|img|product|item/i.test(url);
    } catch {
      return false;
    }
  });
  return sameVendor;
}

function extractPackSizeFromText(text: string): string | undefined {
  const pattern = /\b(pack(?:\s+of)?\s*\d+|\d+\s*pack|case(?:\s+of)?\s*\d+|box(?:\s+of)?\s*\d+)\b/i;
  const match = text.match(pattern);
  return match?.[1] ? normalizeWhitespace(match[1]) : undefined;
}

function extractSkuFromText(text: string): string | undefined {
  const labelMatch = text.match(/\b(?:sku|item(?:\s*#| number)?|part(?:\s*#| number)?|model)\b[:#\s-]*([A-Z0-9][A-Z0-9._-]{2,39})/i);
  if (labelMatch?.[1]) return labelMatch[1].toUpperCase();

  const fallback = text.match(/\b[A-Z0-9]{3,}[._-][A-Z0-9._-]{2,}\b/i);
  return fallback?.[0] ? fallback[0].toUpperCase() : undefined;
}

function extractUpcFromText(text: string): string | undefined {
  const upcLabel = text.match(/\bupc\b[:#\s-]*(\d{8,14})\b/i);
  if (upcLabel?.[1]) return upcLabel[1];

  const standalone = text.match(/\b(\d{12}|\d{13}|\d{14})\b/);
  return standalone?.[1];
}

function extractAsinFromText(text: string): string | undefined {
  const labeled = text.match(/\basin\b[:#\s-]*([A-Z0-9]{10})\b/i);
  if (labeled?.[1]) return labeled[1].toUpperCase();

  const bare = text.match(/\bB0[A-Z0-9]{8}\b/i);
  return bare?.[0] ? bare[0].toUpperCase() : undefined;
}

function extractQuantityFromText(text: string): number | undefined {
  const quantityMatch = text.match(/\b(?:qty|quantity|ordered)\b[:\s-]*(\d+(?:\.\d+)?)\b/i);
  if (quantityMatch?.[1]) return toPositiveInt(quantityMatch[1], 1);

  const xMatch = text.match(/\b(\d+)\s*[x×]\b/);
  if (xMatch?.[1]) return toPositiveInt(xMatch[1], 1);

  return undefined;
}

function extractUnitPriceFromText(text: string): number | undefined {
  const unitMatch = text.match(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:\/|each|ea\b|unit\b)/i);
  if (unitMatch?.[1]) return toNumber(unitMatch[1].replace(/,/g, '')) ?? undefined;

  const labeled = text.match(/\bunit(?:\s+price)?\b[:\s-]*\$?\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
  if (labeled?.[1]) return toNumber(labeled[1].replace(/,/g, '')) ?? undefined;

  return undefined;
}

function extractLineTotalFromText(text: string): number | undefined {
  const totalMatch = text.match(/\b(?:line\s*total|subtotal|total)\b[:\s-]*\$?\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
  if (totalMatch?.[1]) return toNumber(totalMatch[1].replace(/,/g, '')) ?? undefined;

  const price = text.match(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
  return price?.[1] ? toNumber(price[1].replace(/,/g, '')) ?? undefined : undefined;
}

function extractItemNameFromLine(line: string): string {
  const withoutNoise = line
    .replace(/\b(?:qty|quantity|ordered|sku|asin|upc|unit price|price|line total|total)\b[:#]?[^\s]*/gi, ' ')
    .replace(/\$\s?\d+(?:,\d{3})*(?:\.\d{1,2})?/g, ' ')
    .replace(/\b\d+\s*(?:x|pack|case|box)\b/gi, ' ')
    .replace(/[|•]+/g, ' ');

  const cleaned = normalizeWhitespace(withoutNoise);
  if (cleaned.length >= 4) return cleaned;
  return normalizeWhitespace(line);
}

function extractItemsFromSignal(signal: GmailMessageSignal): GmailDetectedOrderItem[] {
  const messageText = `${signal.subject}\n${signal.snippet}\n${signal.bodyText}`.slice(0, 20_000);
  const lines = messageText
    .split(/\n+/g)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 500);

  const url = extractPreferredUrlFromSignal(signal);
  const imageUrl = extractImageUrlFromText(messageText, signal);
  const candidates: GmailDetectedOrderItem[] = [];

  for (const line of lines) {
    const looksLikeItem =
      /\b(?:sku|asin|upc|qty|quantity|item|part|model|unit price|line total|pack)\b/i.test(line) ||
      /\$\s?\d/.test(line) ||
      /\|\s*/.test(line);
    if (!looksLikeItem) continue;

    const name = extractItemNameFromLine(line);
    if (name.length < 4) continue;

    const quantity = extractQuantityFromText(line) ?? 1;
    const item: GmailDetectedOrderItem = {
      name,
      quantity,
      quantityOrdered: quantity,
      sku: extractSkuFromText(line),
      asin: extractAsinFromText(line),
      upc: extractUpcFromText(line),
      unitPrice: extractUnitPriceFromText(line),
      lineTotal: extractLineTotalFromText(line),
      packSize: extractPackSizeFromText(line),
      imageUrl,
      url,
      dateOrdered: signal.receivedAt,
      messageType: signal.messageType,
    };

    candidates.push(enrichItemViaVendorUrlRules(item, signal.domain));
    if (candidates.length >= 24) break;
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const fallbackName = normalizeWhitespace(signal.subject) || `Order from ${signal.vendorName}`;
  return [
    enrichItemViaVendorUrlRules(
      {
        name: fallbackName,
        quantity: 1,
        quantityOrdered: 1,
        url,
        imageUrl,
        dateOrdered: signal.receivedAt,
        messageType: signal.messageType,
      },
      signal.domain,
    ),
  ];
}

function buildHeuristicOrdersFromSignals(signals: GmailMessageSignal[]): GmailDetectedOrder[] {
  const grouped = new Map<
    string,
    {
      vendorName: string;
      domain: string;
      orderDate: string;
      orderDateEpochMs: number;
      orderNumber: string;
      items: GmailDetectedOrderItem[];
      confidence: number;
      summary: string;
    }
  >();

  for (const signal of signals) {
    const orderNumber =
      extractOrderNumber(signal.subject, `${signal.snippet} ${signal.bodyText}`) ||
      `EMAIL-${signal.id.slice(0, 8).toUpperCase()}`;
    const key = `${signal.domain}:${orderNumber}`;
    const messageItems = extractItemsFromSignal(signal);

    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        vendorName: signal.vendorName,
        domain: signal.domain,
        orderDate: signal.receivedAt,
        orderDateEpochMs: signal.receivedEpochMs,
        orderNumber,
        items: messageItems,
        confidence: orderNumber.startsWith('EMAIL-') ? 64 : 78,
        summary: signal.snippet || signal.subject || signal.bodyText.slice(0, 300),
      });
      continue;
    }

    current.items.push(...messageItems);
    if (signal.receivedEpochMs > current.orderDateEpochMs) {
      current.orderDateEpochMs = signal.receivedEpochMs;
      current.orderDate = signal.receivedAt;
      current.summary = signal.snippet || signal.subject || signal.bodyText.slice(0, 300);
    }
  }

  return Array.from(grouped.values())
    .map((entry) => ({
      vendorId: toVendorId({ domain: entry.domain, vendorName: entry.vendorName }),
      vendorName: entry.vendorName,
      domain: entry.domain,
      orderDate: entry.orderDate,
      orderNumber: entry.orderNumber,
      summary: entry.summary,
      confidence: entry.confidence,
      items: entry.items.slice(0, 40),
    }))
    .sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate))
    .slice(0, 120);
}

function normalizeAiDetectedOrders(
  rawOrders: unknown,
  signals: GmailMessageSignal[],
): GmailDetectedOrder[] {
  if (!Array.isArray(rawOrders)) return [];

  const fallbackSignal = signals[0];
  const normalized: GmailDetectedOrder[] = [];

  for (const rawOrder of rawOrders) {
    if (!rawOrder || typeof rawOrder !== 'object') continue;
    const record = rawOrder as Record<string, unknown>;

    const vendorName = maybeString(record.vendorName) || fallbackSignal?.vendorName || 'Unknown Vendor';
    const domain =
      normalizeDomain(record.domain) ||
      signals.find((signal) => signal.vendorName.toLowerCase() === vendorName.toLowerCase())?.domain;

    const rawItems = Array.isArray(record.items) ? record.items : [];
    const items: GmailDetectedOrderItem[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = maybeString(row.name);
      if (!name) continue;

      const quantity = toPositiveInt(
        row.quantityOrdered ?? row.quantity,
        1,
      );
      const dateOrdered = normalizeIsoTimestamp(
        row.dateOrdered,
        normalizeIsoTimestamp(record.orderDate, fallbackSignal?.receivedAt || new Date().toISOString()),
      );
      const messageTypeRaw = maybeString(row.messageType) || maybeString(record.messageType);
      const messageType =
        messageTypeRaw === 'receipt' || messageTypeRaw === 'shipping' || messageTypeRaw === 'delivery'
          ? (messageTypeRaw as PurchaseMessageType)
          : undefined;

      const normalizedItem: GmailDetectedOrderItem = {
        name,
        quantity,
        quantityOrdered: quantity,
        dateOrdered,
        messageType,
      };

      const sku = maybeString(row.sku);
      const asin = maybeString(row.asin);
      const upc = maybeString(row.upc);
      const unitPrice = toNumber(row.unitPrice) ?? undefined;
      const lineTotal = toNumber(row.lineTotal) ?? undefined;
      const packSize = maybeString(row.packSize);
      const imageUrl = maybeString(row.imageUrl);
      const url = maybeString(row.url);

      if (sku) normalizedItem.sku = sku;
      if (asin) normalizedItem.asin = asin;
      if (upc) normalizedItem.upc = upc;
      if (unitPrice !== undefined) normalizedItem.unitPrice = unitPrice;
      if (lineTotal !== undefined) normalizedItem.lineTotal = lineTotal;
      if (packSize) normalizedItem.packSize = packSize;
      if (imageUrl) normalizedItem.imageUrl = imageUrl;
      if (url) normalizedItem.url = url;

      items.push(enrichItemViaVendorUrlRules(normalizedItem, domain));
    }

    if (items.length === 0) {
      const messageTypeRaw = maybeString(record.messageType);
      const fallbackMessageType =
        messageTypeRaw === 'receipt' || messageTypeRaw === 'shipping' || messageTypeRaw === 'delivery'
          ? (messageTypeRaw as PurchaseMessageType)
          : undefined;
      items.push({
        name: maybeString(record.summary) || `Purchase email from ${vendorName}`,
        quantity: 1,
        quantityOrdered: 1,
        dateOrdered: normalizeIsoTimestamp(
          record.orderDate,
          fallbackSignal?.receivedAt || new Date().toISOString(),
        ),
        messageType: fallbackMessageType,
      });
    }

    const orderDateFallback =
      signals.find((signal) => signal.vendorName.toLowerCase() === vendorName.toLowerCase())?.receivedAt ||
      fallbackSignal?.receivedAt ||
      new Date().toISOString();
    const orderNumber =
      maybeString(record.orderNumber) ||
      extractOrderNumber(maybeString(record.subject) || '', maybeString(record.summary) || '') ||
      `EMAIL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    normalized.push({
      vendorId: toVendorId({ domain, vendorName }),
      vendorName,
      domain,
      orderDate: normalizeIsoTimestamp(record.orderDate, orderDateFallback),
      orderNumber,
      summary: maybeString(record.summary),
      confidence: toConfidencePercent(record.confidence, 72),
      items: items.slice(0, 40),
    });
  }

  return normalized
    .sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate))
    .slice(0, 120);
}

function applyVendorRuleEnrichmentToOrders(
  orders: GmailDetectedOrder[],
): GmailDetectedOrder[] {
  return orders.map((order) => ({
    ...order,
    vendorId: toVendorId({ domain: order.domain, vendorName: order.vendorName }),
    vendorName: order.domain
      ? resolveKnownVendorByDomain(order.domain)?.name || order.vendorName
      : order.vendorName,
    items: order.items.map((item) => enrichItemViaVendorUrlRules(item, order.domain)),
  }));
}

export async function discoverGmailOrdersForUser(input: {
  userId: string;
  maxResults?: number;
  lookbackDays?: number;
  vendorIds?: string[];
}): Promise<GmailOrderDiscoveryResult> {
  const { signals, hasMore } = await fetchGmailMessageSignalsForUser({
    userId: input.userId,
    maxResults: input.maxResults,
    lookbackDays: input.lookbackDays,
    vendorIds: input.vendorIds,
  });

  const suppliers = aggregateSuppliersFromSignals(signals);
  if (signals.length === 0) {
    return {
      orders: [],
      suppliers,
      scannedMessages: 0,
      hasMore,
      analysisMode: 'heuristic',
      analysisWarning:
        'No qualifying industrial supplier receipts/shipping/delivery emails were found in the lookback window.',
    };
  }

  if (!isOpenAiConfigured()) {
    return {
      orders: applyVendorRuleEnrichmentToOrders(buildHeuristicOrdersFromSignals(signals)),
      suppliers,
      scannedMessages: signals.length,
      hasMore,
      analysisMode: 'heuristic',
      analysisWarning:
        'OPENAI_API_KEY is not configured. Using deterministic industrial email parsing.',
    };
  }

  try {
    const aiPayload = await callOpenAiChatCompletionJson({
      messages: [
        {
          role: 'system',
          content:
            'Extract industrial supplier order history from Gmail metadata. Return strict JSON: {"orders":[{"vendorName":"string","domain":"string","orderDate":"ISO-8601","orderNumber":"string","summary":"string","messageType":"receipt|shipping|delivery","confidence":0-1,"items":[{"name":"string","quantityOrdered":number,"quantity":number,"sku":"string","asin":"string","upc":"string","unitPrice":number,"lineTotal":number,"packSize":"string","imageUrl":"string","url":"string","dateOrdered":"ISO-8601","messageType":"receipt|shipping|delivery"}]}]}. Include only receipts, shipping notifications, or delivery notifications from industrial distributors/suppliers. Exclude calendar invites, marketing/promotional emails, subscription/renewal notices, and any banking/financial institution messages.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            messages: signals.slice(0, 140).map((signal) => ({
              id: signal.id,
              from: signal.from,
              domain: signal.domain,
              vendorName: signal.vendorName,
              subject: signal.subject,
              snippet: signal.snippet,
              bodyText: signal.bodyText.slice(0, 5_000),
              messageType: signal.messageType,
              receivedAt: signal.receivedAt,
            })),
          }),
        },
      ],
      maxTokens: 2200,
      temperature: 0.1,
    });

    const aiOrders = applyVendorRuleEnrichmentToOrders(normalizeAiDetectedOrders(aiPayload.orders, signals));
    if (aiOrders.length > 0) {
      return {
        orders: aiOrders,
        suppliers,
        scannedMessages: signals.length,
        hasMore,
        analysisMode: 'ai',
      };
    }
  } catch (error) {
    return {
      orders: applyVendorRuleEnrichmentToOrders(buildHeuristicOrdersFromSignals(signals)),
      suppliers,
      scannedMessages: signals.length,
      hasMore,
      analysisMode: 'heuristic',
      analysisWarning:
        error instanceof Error
          ? `AI email analysis failed: ${error.message}. Using deterministic parsing instead.`
          : 'AI email analysis failed. Using deterministic parsing instead.',
    };
  }

  return {
    orders: applyVendorRuleEnrichmentToOrders(buildHeuristicOrdersFromSignals(signals)),
    suppliers,
    scannedMessages: signals.length,
    hasMore,
    analysisMode: 'heuristic',
    analysisWarning:
      'AI analysis returned no structured industrial orders. Using deterministic parsing.',
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number, fallback: number): number {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index] ?? fallback;
}

function normalizeIdentityToken(value?: string): string | undefined {
  if (!value) return undefined;
  const token = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return token || undefined;
}

function parsePackMultiple(packSize?: string): number {
  if (!packSize) return 1;
  const match = packSize.match(/(\d{1,4})/);
  if (!match?.[1]) return 1;
  return Math.max(1, Math.min(10_000, Number.parseInt(match[1], 10)));
}

function roundUpToMultiple(value: number, multiple: number): number {
  const safeMultiple = Math.max(1, multiple);
  return Math.max(safeMultiple, Math.ceil(Math.max(1, value) / safeMultiple) * safeMultiple);
}

function toHistoryIdentity(item: Pick<GmailDetectedOrderItem, 'sku' | 'asin' | 'upc' | 'name'>): string {
  return (
    normalizeIdentityToken(item.sku) ||
    normalizeIdentityToken(item.asin) ||
    normalizeIdentityToken(item.upc) ||
    normalizeIdentityToken(item.name) ||
    'item'
  );
}

function buildOrderHistoryAggregates(orders: OrderEnrichmentInput[]): OrderHistoryAggregate[] {
  const byKey = new Map<string, OrderHistoryAggregate>();

  for (const order of orders) {
    const normalizedOrderDate = normalizeIsoTimestamp(order.orderDate);
    for (const item of order.items) {
      const key = `${order.vendorId}:${toHistoryIdentity(item)}`;
      const quantity = toPositiveInt(item.quantityOrdered ?? item.quantity, 1);
      const itemDate = normalizeIsoTimestamp(item.dateOrdered, normalizedOrderDate);

      const aggregate = byKey.get(key) || {
        key,
        vendorId: order.vendorId,
        vendorName: order.vendorName,
        name: item.name,
        sku: item.sku,
        asin: item.asin,
        upc: item.upc,
        imageUrl: item.imageUrl,
        productUrl: item.url,
        packSize: item.packSize,
        quantities: [],
        unitPrices: [],
        orderDates: [],
        moq: 1,
        recommendedOrderQuantity: 1,
        recommendedMinQuantity: 1,
        statedLeadTimeDays: 7,
        safetyStockDays: 3,
      };

      if (!aggregate.sku && item.sku) aggregate.sku = item.sku;
      if (!aggregate.asin && item.asin) aggregate.asin = item.asin;
      if (!aggregate.upc && item.upc) aggregate.upc = item.upc;
      if (!aggregate.imageUrl && item.imageUrl) aggregate.imageUrl = item.imageUrl;
      if (!aggregate.productUrl && item.url) aggregate.productUrl = item.url;
      if (!aggregate.packSize && item.packSize) aggregate.packSize = item.packSize;
      if ((!aggregate.name || aggregate.name.length < 4) && item.name) aggregate.name = item.name;

      aggregate.quantities.push(quantity);
      if (typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) && item.unitPrice > 0) {
        aggregate.unitPrices.push(item.unitPrice);
      } else if (
        typeof item.lineTotal === 'number' &&
        Number.isFinite(item.lineTotal) &&
        item.lineTotal > 0 &&
        quantity > 0
      ) {
        aggregate.unitPrices.push(item.lineTotal / quantity);
      }
      aggregate.orderDates.push(itemDate);

      byKey.set(key, aggregate);
    }
  }

  for (const aggregate of byKey.values()) {
    const dateEpochs = Array.from(
      new Set(
        aggregate.orderDates
          .map((date) => Date.parse(date))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    ).sort((a, b) => a - b);

    const intervals: number[] = [];
    for (let i = 1; i < dateEpochs.length; i += 1) {
      const prev = dateEpochs[i - 1];
      const next = dateEpochs[i];
      if (!prev || !next) continue;
      const days = Math.max(1, Math.round((next - prev) / (1000 * 60 * 60 * 24)));
      intervals.push(days);
    }

    const cadenceDays = clampInt(Math.round(average(intervals) ?? 30), 3, 120);
    aggregate.cadenceDays = cadenceDays;
    aggregate.avgUnitPrice = average(aggregate.unitPrices);

    const packMultiple = parsePackMultiple(aggregate.packSize);
    const avgQty = average(aggregate.quantities) ?? 1;
    const medianQty = percentile(aggregate.quantities, 0.5, avgQty);
    const p75Qty = percentile(aggregate.quantities, 0.75, Math.max(avgQty, medianQty));

    const moq = roundUpToMultiple(Math.max(1, Math.round(medianQty)), packMultiple);
    const orderQty = roundUpToMultiple(
      Math.max(moq, Math.round(Math.max(p75Qty, avgQty))),
      packMultiple,
    );
    const statedLeadTimeDays = clampInt(Math.round(cadenceDays * 0.35), 2, 30);
    const safetyStockDays = clampInt(Math.round(cadenceDays * 0.25), 2, 21);
    const avgDailyUsage = orderQty / Math.max(cadenceDays, 1);
    const minQty = roundUpToMultiple(
      Math.max(1, Math.round(avgDailyUsage * (statedLeadTimeDays + safetyStockDays))),
      packMultiple,
    );

    aggregate.moq = moq;
    aggregate.recommendedOrderQuantity = Math.max(orderQty, moq);
    aggregate.recommendedMinQuantity = Math.max(minQty, 1);
    aggregate.statedLeadTimeDays = statedLeadTimeDays;
    aggregate.safetyStockDays = safetyStockDays;
  }

  return Array.from(byKey.values());
}

function findMatchingHistoryAggregate(
  historyAggregates: OrderHistoryAggregate[],
  input: {
    vendorId?: string;
    sku?: string;
    asin?: string;
    upc?: string;
    name?: string;
  },
): OrderHistoryAggregate | undefined {
  const vendorId = input.vendorId?.trim();
  const skuToken = normalizeIdentityToken(input.sku);
  const asinToken = normalizeIdentityToken(input.asin);
  const upcToken = normalizeIdentityToken(input.upc);
  const nameToken = normalizeIdentityToken(input.name);

  return historyAggregates.find((aggregate) => {
    if (vendorId && aggregate.vendorId !== vendorId) return false;
    const aggSku = normalizeIdentityToken(aggregate.sku);
    const aggAsin = normalizeIdentityToken(aggregate.asin);
    const aggUpc = normalizeIdentityToken(aggregate.upc);
    const aggName = normalizeIdentityToken(aggregate.name);
    return Boolean(
      (skuToken && aggSku && skuToken === aggSku) ||
        (asinToken && aggAsin && asinToken === aggAsin) ||
        (upcToken && aggUpc && upcToken === aggUpc) ||
        (nameToken && aggName && nameToken === aggName),
    );
  });
}

function buildHeuristicEmailEnrichment(
  historyAggregates: OrderHistoryAggregate[],
): AiEmailEnrichedProduct[] {
  return historyAggregates.map((aggregate) => {
    const sampleSize = aggregate.orderDates.length;
    const confidence = clampInt(52 + sampleSize * 6, 55, 90);
    return {
      name: aggregate.name,
      sku: aggregate.sku,
      asin: aggregate.asin,
      upc: aggregate.upc,
      imageUrl: aggregate.imageUrl,
      vendorId: aggregate.vendorId,
      vendorName: aggregate.vendorName,
      productUrl: aggregate.productUrl,
      description: `Derived from ${sampleSize} historical order line${sampleSize === 1 ? '' : 's'} in Gmail.`,
      unitPrice: aggregate.avgUnitPrice,
      moq: aggregate.moq,
      orderCadenceDays: aggregate.cadenceDays,
      recommendedOrderQuantity: aggregate.recommendedOrderQuantity,
      recommendedMinQuantity: aggregate.recommendedMinQuantity,
      statedLeadTimeDays: aggregate.statedLeadTimeDays,
      safetyStockDays: aggregate.safetyStockDays,
      orderHistorySampleSize: sampleSize,
      confidence,
      needsReview: sampleSize < 2,
    };
  });
}

function normalizeAiEnrichedProducts(
  rawProducts: unknown,
  orders: OrderEnrichmentInput[],
  historyAggregates: OrderHistoryAggregate[],
): AiEmailEnrichedProduct[] {
  if (!Array.isArray(rawProducts)) return [];

  const orderByVendor = new Map<string, OrderEnrichmentInput>();
  for (const order of orders) {
    const key = `${order.vendorId}:${order.vendorName.toLowerCase()}`;
    if (!orderByVendor.has(key)) {
      orderByVendor.set(key, order);
    }
  }

  const normalized: AiEmailEnrichedProduct[] = [];
  for (const rawProduct of rawProducts) {
    if (!rawProduct || typeof rawProduct !== 'object') continue;
    const record = rawProduct as Record<string, unknown>;
    const name = maybeString(record.name);
    if (!name) continue;

    const vendorId = maybeString(record.vendorId);
    const vendorName = maybeString(record.vendorName);
    const matchedOrder =
      (vendorId && vendorName && orderByVendor.get(`${vendorId}:${vendorName.toLowerCase()}`)) ||
      (vendorName
        ? orders.find((order) => order.vendorName.toLowerCase() === vendorName.toLowerCase())
        : undefined) ||
      orders[0];
    const resolvedVendorId = vendorId || matchedOrder?.vendorId || 'unknown-vendor';
    const matchedHistory = findMatchingHistoryAggregate(historyAggregates, {
      vendorId: resolvedVendorId,
      sku: maybeString(record.sku),
      asin: maybeString(record.asin),
      upc: maybeString(record.upc),
      name,
    });
    const fallbackMoq = matchedHistory?.moq ?? 10;
    const fallbackCadence = matchedHistory?.cadenceDays ?? 30;
    const fallbackConfidence = matchedHistory ? clampInt(70 + matchedHistory.orderDates.length * 3, 70, 94) : 72;

    normalized.push({
      name,
      sku: maybeString(record.sku),
      asin: maybeString(record.asin),
      upc: maybeString(record.upc),
      imageUrl: maybeString(record.imageUrl) || matchedHistory?.imageUrl,
      vendorId: resolvedVendorId,
      vendorName: vendorName || matchedOrder?.vendorName || 'Unknown Vendor',
      productUrl: maybeString(record.productUrl) || matchedHistory?.productUrl,
      description: maybeString(record.description),
      unitPrice: toNumber(record.unitPrice) ?? matchedHistory?.avgUnitPrice,
      moq: toPositiveInt(record.moq, fallbackMoq),
      orderCadenceDays: toPositiveInt(record.orderCadenceDays, fallbackCadence),
      recommendedOrderQuantity: toPositiveInt(
        record.recommendedOrderQuantity,
        matchedHistory?.recommendedOrderQuantity ?? toPositiveInt(record.moq, fallbackMoq),
      ),
      recommendedMinQuantity: toPositiveInt(
        record.recommendedMinQuantity,
        matchedHistory?.recommendedMinQuantity ?? toPositiveInt(record.moq, fallbackMoq),
      ),
      statedLeadTimeDays: toPositiveInt(
        record.statedLeadTimeDays,
        matchedHistory?.statedLeadTimeDays ?? 7,
      ),
      safetyStockDays: toPositiveInt(
        record.safetyStockDays,
        matchedHistory?.safetyStockDays ?? 3,
      ),
      orderHistorySampleSize: matchedHistory?.orderDates.length,
      confidence: toConfidencePercent(record.confidence, fallbackConfidence),
      needsReview:
        typeof record.needsReview === 'boolean'
          ? record.needsReview
          : toConfidencePercent(record.confidence, fallbackConfidence) < 80,
    });
  }

  return normalized;
}

export async function enrichDetectedOrdersWithAi(input: {
  orders: OrderEnrichmentInput[];
}): Promise<AiEmailEnrichmentResult> {
  if (!input.orders.length) {
    return { products: [], mode: 'heuristic' };
  }

  const orderHistoryAggregates = buildOrderHistoryAggregates(input.orders);
  const heuristicProducts = buildHeuristicEmailEnrichment(orderHistoryAggregates);
  if (!isOpenAiConfigured()) {
    return {
      products: heuristicProducts,
      mode: 'heuristic',
      warning: 'OPENAI_API_KEY is not configured. Using deterministic enrichment.',
    };
  }

  try {
    const aiPayload = await callOpenAiChatCompletionJson({
      messages: [
        {
          role: 'system',
          content:
            'You enrich industrial procurement products from historical order lines. Return strict JSON: {"products":[{"name":"string","sku":"string","asin":"string","upc":"string","imageUrl":"string","vendorId":"string","vendorName":"string","productUrl":"string","description":"string","unitPrice":number,"moq":number,"orderCadenceDays":number,"recommendedOrderQuantity":number,"recommendedMinQuantity":number,"statedLeadTimeDays":number,"safetyStockDays":number,"confidence":0-100,"needsReview":boolean}]}. Use order history statistics to inform kanban defaults. Keep recommendations conservative and integer-valued.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            orders: input.orders.slice(0, 120),
            orderHistory: orderHistoryAggregates.map((entry) => ({
              vendorId: entry.vendorId,
              vendorName: entry.vendorName,
              name: entry.name,
              sku: entry.sku,
              asin: entry.asin,
              upc: entry.upc,
              orderCount: entry.orderDates.length,
              cadenceDays: entry.cadenceDays,
              moq: entry.moq,
              recommendedOrderQuantity: entry.recommendedOrderQuantity,
              recommendedMinQuantity: entry.recommendedMinQuantity,
              statedLeadTimeDays: entry.statedLeadTimeDays,
              safetyStockDays: entry.safetyStockDays,
              avgUnitPrice: entry.avgUnitPrice,
            })),
          }),
        },
      ],
      maxTokens: 2600,
      temperature: 0.2,
    });

    const normalized = normalizeAiEnrichedProducts(
      aiPayload.products,
      input.orders,
      orderHistoryAggregates,
    );
    if (normalized.length > 0) {
      return {
        products: normalized,
        mode: 'ai',
      };
    }
  } catch (error) {
    return {
      products: heuristicProducts,
      mode: 'heuristic',
      warning:
        error instanceof Error
          ? `AI enrichment failed: ${error.message}. Using deterministic enrichment instead.`
          : 'AI enrichment failed. Using deterministic enrichment instead.',
    };
  }

  return {
    products: heuristicProducts,
    mode: 'heuristic',
    warning: 'AI enrichment returned no products. Using deterministic enrichment.',
  };
}

function normalizeAiImagePredictions(rawPredictions: unknown): AiImagePrediction[] {
  if (!Array.isArray(rawPredictions)) return [];

  const normalized: AiImagePrediction[] = [];
  for (const entry of rawPredictions) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = maybeString(record.label);
    if (!label) continue;

    const suggestedRaw =
      record.suggestedProduct && typeof record.suggestedProduct === 'object'
        ? (record.suggestedProduct as Record<string, unknown>)
        : null;

    const prediction: AiImagePrediction = {
      label,
      confidence: toConfidenceUnit(record.confidence, 0.7),
    };

    if (suggestedRaw) {
      const suggestedProduct: Partial<AiEmailEnrichedProduct> = {};
      const name = maybeString(suggestedRaw.name);
      const sku = maybeString(suggestedRaw.sku);
      const asin = maybeString(suggestedRaw.asin);
      const upc = maybeString(suggestedRaw.upc);
      const vendorId = maybeString(suggestedRaw.vendorId);
      const vendorName = maybeString(suggestedRaw.vendorName);
      const description = maybeString(suggestedRaw.description);
      const confidence = toConfidencePercent(suggestedRaw.confidence, 70);
      const moq = toPositiveInt(suggestedRaw.moq, 1);
      const needsReview =
        typeof suggestedRaw.needsReview === 'boolean' ? suggestedRaw.needsReview : false;

      if (name) suggestedProduct.name = name;
      if (sku) suggestedProduct.sku = sku;
      if (asin) suggestedProduct.asin = asin;
      if (upc) suggestedProduct.upc = upc;
      if (vendorId) suggestedProduct.vendorId = vendorId;
      if (vendorName) suggestedProduct.vendorName = vendorName;
      if (description) suggestedProduct.description = description;
      suggestedProduct.confidence = confidence;
      suggestedProduct.moq = moq;
      suggestedProduct.needsReview = needsReview;

      prediction.suggestedProduct = suggestedProduct;
    }

    normalized.push(prediction);
    if (normalized.length >= 5) break;
  }

  return normalized;
}

export async function identifyProductImageWithAi(input: {
  imageDataUrl: string;
  fileName?: string;
}): Promise<AiImageAnalysisResult> {
  if (!isOpenAiConfigured()) {
    throw new AppError(
      503,
      'AI image analysis is not configured (missing OPENAI_API_KEY).',
      'AI_NOT_CONFIGURED',
    );
  }

  const aiPayload = await callOpenAiChatCompletionJson({
    messages: [
      {
        role: 'system',
        content:
          'Analyze the product image and return strict JSON: {"predictions":[{"label":"string","confidence":0-1,"suggestedProduct":{"name":"string","sku":"string","asin":"string","upc":"string","vendorName":"string","vendorId":"string","description":"string","moq":number}}]}. Provide up to 3 likely candidates.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this product image for procurement intake. File name: ${input.fileName || 'unknown-image'}`,
          },
          {
            type: 'image_url',
            image_url: {
              url: input.imageDataUrl,
            },
          },
        ],
      },
    ],
    maxTokens: 1400,
    temperature: 0.1,
  });

  const predictions = normalizeAiImagePredictions(aiPayload.predictions);
  if (predictions.length === 0) {
    throw new AppError(502, 'AI image analysis returned no predictions.', 'AI_EMPTY_IMAGE_ANALYSIS');
  }

  return { predictions };
}

async function lookupUpcViaBarcodeLookup(upc: string): Promise<UpcLookupProduct | null> {
  if (!config.BARCODE_LOOKUP_API_KEY?.trim()) return null;

  const endpoint = new URL('https://api.barcodelookup.com/v3/products');
  endpoint.searchParams.set('barcode', upc);
  endpoint.searchParams.set('formatted', 'y');
  endpoint.searchParams.set('key', config.BARCODE_LOOKUP_API_KEY);

  const response = await fetch(endpoint.toString(), {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    products?: Array<{
      title?: string;
      product_name?: string;
      brand?: string;
      manufacturer?: string;
      description?: string;
      images?: string[];
      category?: string;
      stores?: Array<{ store_url?: string }>;
    }>;
  };

  const product = payload.products?.[0];
  if (!product) return null;

  const name = product.title || product.product_name;
  if (!name) return null;

  return {
    upc,
    name,
    brand: product.brand || product.manufacturer,
    description: product.description,
    imageUrl: product.images?.[0],
    category: product.category,
    productUrl: product.stores?.find((store) => Boolean(store.store_url))?.store_url,
    moq: 1,
    confidence: 0.92,
  };
}

async function lookupUpcViaOpenFoodFacts(upc: string): Promise<UpcLookupProduct | null> {
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    status?: number;
    product?: {
      code?: string;
      product_name?: string;
      generic_name?: string;
      brands?: string;
      image_url?: string;
      categories?: string;
      ingredients_text?: string;
      url?: string;
    };
  };
  if (payload.status !== 1 || !payload.product) return null;

  const product = payload.product;
  const name = product.product_name || product.generic_name;
  if (!name) return null;

  return {
    upc: product.code || upc,
    name,
    brand: product.brands,
    description: product.ingredients_text,
    imageUrl: product.image_url,
    category: product.categories,
    productUrl: product.url,
    moq: 1,
    confidence: 0.78,
  };
}

export async function lookupUpcProduct(input: { upc: string }): Promise<UpcLookupResult> {
  const normalizedUpc = input.upc.trim();
  if (!/^\d{8,14}$/.test(normalizedUpc)) {
    throw new AppError(400, 'UPC must be 8-14 digits.', 'UPC_INVALID');
  }

  const barcodeLookup = await lookupUpcViaBarcodeLookup(normalizedUpc);
  if (barcodeLookup) {
    return {
      upc: normalizedUpc,
      found: true,
      provider: 'barcodelookup',
      product: barcodeLookup,
    };
  }

  const openFoodFacts = await lookupUpcViaOpenFoodFacts(normalizedUpc);
  if (openFoodFacts) {
    return {
      upc: normalizedUpc,
      found: true,
      provider: 'openfoodfacts',
      product: openFoodFacts,
    };
  }

  return {
    upc: normalizedUpc,
    found: false,
    provider: 'none',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────
async function createTokenPair(
  userId: string,
  tenantId: string,
  email: string,
  role: string,
  dbClient: typeof db = db
): Promise<TokenPair> {
  const tokenId = crypto.randomUUID();

  // Generate tokens
  const accessToken = generateAccessToken({ sub: userId, tenantId, email, role });
  const refreshTokenStr = generateRefreshToken(userId, tokenId);
  const refreshPayload = verifyRefreshToken(refreshTokenStr);
  const expiresAt = refreshPayload.exp
    ? new Date(refreshPayload.exp * 1000)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await dbClient.insert(refreshTokens).values({
    id: tokenId,
    userId,
    tokenHash: hashToken(refreshTokenStr),
    expiresAt,
  });

  return { accessToken, refreshToken: refreshTokenStr };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}
