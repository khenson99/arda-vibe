import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service.js';
import { authMiddleware, type AuthRequest } from '@arda/auth-utils';
import { db, schema } from '@arda/db';
import { eq } from 'drizzle-orm';

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
