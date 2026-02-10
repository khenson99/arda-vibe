import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service.js';
import { authMiddleware, type AuthRequest } from '@arda/auth-utils';
import { db, schema } from '@arda/db';
import { eq } from 'drizzle-orm';
import { config } from '@arda/config';
import crypto from 'crypto';

export const authRouter = Router();

// ─── Validation Schemas ───────────────────────────────────────────────
const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  companyName: z.string().min(1, 'Company name is required').max(255),
  companySlug: z.string().max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

const googleLinkInitSchema = z.object({
  origin: z.string().url().optional(),
});

const googleVendorDiscoveryQuerySchema = z.object({
  maxResults: z.coerce.number().int().min(20).max(250).optional(),
});

interface GoogleLinkStatePayload {
  userId: string;
  origin: string;
  exp: number;
}

const allowedOriginSet = new Set(
  [
    config.APP_URL,
    ...(config.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => Boolean(origin)),
);

function sanitizeOrigin(rawOrigin?: string): string {
  const fallbackOrigin = new URL(config.APP_URL).origin;
  if (!rawOrigin) return fallbackOrigin;

  try {
    const parsed = new URL(rawOrigin);
    return allowedOriginSet.has(parsed.origin) ? parsed.origin : fallbackOrigin;
  } catch {
    return fallbackOrigin;
  }
}

function resolveGoogleLinkCallbackUrl(): string {
  if (config.GOOGLE_CALLBACK_URL?.trim()) {
    return config.GOOGLE_CALLBACK_URL.trim();
  }

  if (config.NODE_ENV !== 'production') {
    return 'http://localhost:3000/api/auth/google/link/callback';
  }

  throw new Error('GOOGLE_CALLBACK_URL is required in production for Gmail OAuth linking.');
}

function signGoogleLinkState(payload: GoogleLinkStatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyGoogleLinkState(rawState: string): GoogleLinkStatePayload {
  const [encoded, signature] = rawState.split('.');
  if (!encoded || !signature) {
    throw new Error('Invalid Google OAuth state format.');
  }

  const expected = crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(encoded)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error('Invalid Google OAuth state signature.');
  }

  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as GoogleLinkStatePayload;
  if (!parsed.userId || !parsed.origin || !parsed.exp) {
    throw new Error('Invalid Google OAuth state payload.');
  }
  if (Date.now() > parsed.exp) {
    throw new Error('Google OAuth state has expired.');
  }

  return {
    ...parsed,
    origin: sanitizeOrigin(parsed.origin),
  };
}

function renderGoogleLinkCallbackHtml(input: {
  targetOrigin: string;
  status: 'success' | 'error';
  email?: string;
  error?: string;
}): string {
  const payload = {
    type: 'arda:google-oauth-link',
    status: input.status,
    email: input.email,
    error: input.error,
  };

  const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  const originJson = JSON.stringify(input.targetOrigin).replace(/</g, '\\u003c');
  const fallbackPath =
    input.status === 'success'
      ? `/?gmail_oauth=success&gmail_email=${encodeURIComponent(input.email || '')}`
      : `/?gmail_oauth=error&gmail_error=${encodeURIComponent(input.error || 'OAuth failed')}`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Arda Gmail Link</title>
  </head>
  <body>
    <p>Completing Google link…</p>
    <script>
      (function () {
        var payload = ${payloadJson};
        var targetOrigin = ${originJson};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, targetOrigin);
            window.close();
            return;
          }
        } catch (error) {}
        window.location.href = targetOrigin + ${JSON.stringify(fallbackPath)};
      })();
    </script>
  </body>
</html>`;
}

function sendGoogleLinkCallbackHtml(
  res: any,
  statusCode: number,
  html: string,
): void {
  // Allow this page's small inline script to notify the opener window and close.
  // Helmet's default CSP blocks inline scripts, which would leave the popup hanging.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; frame-ancestors 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  );
  // Preserve opener relationship for cross-origin popup postMessage callbacks.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');

  res.status(statusCode).type('html').send(html);
}

export async function handleGoogleLinkCallback(req: any, res: any): Promise<void> {
  const fallbackOrigin = sanitizeOrigin(undefined);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';

  if (!code || !stateRaw) {
    sendGoogleLinkCallbackHtml(
      res,
      400,
      renderGoogleLinkCallbackHtml({
        targetOrigin: fallbackOrigin,
        status: 'error',
        error: 'Missing Google OAuth callback parameters.',
      }),
    );
    return;
  }

  let state: GoogleLinkStatePayload;
  try {
    state = verifyGoogleLinkState(stateRaw);
  } catch (error) {
    sendGoogleLinkCallbackHtml(
      res,
      400,
      renderGoogleLinkCallbackHtml({
        targetOrigin: fallbackOrigin,
        status: 'error',
        error: error instanceof Error ? error.message : 'Invalid OAuth state.',
      }),
    );
    return;
  }

  try {
    const callbackUrl = resolveGoogleLinkCallbackUrl();
    const { profile, tokens } = await authService.exchangeGoogleOAuthCode({
      code,
      redirectUri: callbackUrl,
    });
    await authService.linkGoogleOAuthForUser({
      userId: state.userId,
      profile,
      tokens,
    });

    sendGoogleLinkCallbackHtml(
      res,
      200,
      renderGoogleLinkCallbackHtml({
        targetOrigin: state.origin,
        status: 'success',
        email: profile.email,
      }),
    );
  } catch (error) {
    sendGoogleLinkCallbackHtml(
      res,
      400,
      renderGoogleLinkCallbackHtml({
        targetOrigin: state.origin,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to link Gmail account.',
      }),
    );
  }
}

// ─── POST /auth/register ──────────────────────────────────────────────
authRouter.post('/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const result = await authService.register(input);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────
authRouter.post('/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const result = await authService.login(input);
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/refresh ───────────────────────────────────────────────
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const input = refreshSchema.parse(req.body);
    const tokens = await authService.refreshAccessToken(input.refreshToken);
    res.json(tokens);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/forgot-password ──────────────────────────────────────
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const input = forgotPasswordSchema.parse(req.body);
    await authService.forgotPassword({ email: input.email });

    res.json({
      message:
        'If an account exists for that email, a password reset link has been sent.',
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/reset-password ───────────────────────────────────────
authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const input = resetPasswordSchema.parse(req.body);
    await authService.resetPassword({
      token: input.token,
      newPassword: input.newPassword,
    });

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/google ────────────────────────────────────────────────
// Receives a Google ID token from the frontend, verifies it server-side
// using google-auth-library, and creates/logs in the user.
authRouter.post('/google', async (req, res, next) => {
  try {
    const googleTokenSchema = z.object({
      idToken: z.string().min(1, 'Google ID token is required'),
    });
    const { idToken } = googleTokenSchema.parse(req.body);
    const profile = await authService.verifyGoogleIdToken(idToken);
    const result = await authService.handleGoogleOAuth(profile);
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── POST /auth/google/link/init ─────────────────────────────────────
// Starts OAuth for linking a Gmail inbox to the currently authenticated user.
authRouter.post('/google/link/init', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const input = googleLinkInitSchema.parse(req.body ?? {});
    const origin = sanitizeOrigin(input.origin);
    const callbackUrl = resolveGoogleLinkCallbackUrl();
    const state = signGoogleLinkState({
      userId: req.user!.sub,
      origin,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const authorizationUrl = authService.generateGoogleOAuthAuthorizationUrl({
      state,
      redirectUri: callbackUrl,
    });

    res.json({ authorizationUrl });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── GET /auth/google/link/callback ──────────────────────────────────
// Completes OAuth link flow, stores Gmail tokens, and notifies the frontend.
authRouter.get('/google/link/callback', handleGoogleLinkCallback);

// Backward-compatible callback path for existing Google OAuth client configs.
authRouter.get('/google/callback', handleGoogleLinkCallback);

// ─── GET /auth/google/vendors/discover ──────────────────────────────
// Scans Gmail metadata to infer likely suppliers from sender domains.
authRouter.get('/google/vendors/discover', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const query = googleVendorDiscoveryQuerySchema.parse(req.query ?? {});
    const result = await authService.discoverGmailSuppliersForUser({
      userId: req.user!.sub,
      maxResults: query.maxResults,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(err);
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────
authRouter.get('/me', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, req.user!.sub),
      with: { tenant: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      avatarUrl: user.avatarUrl,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
      tenantSlug: user.tenant.slug,
      tenantLogo: user.tenant.logoUrl,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────
authRouter.post('/logout', authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    // Revoke all refresh tokens for this user (full logout)
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.refreshTokens.userId, req.user!.sub));

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});
