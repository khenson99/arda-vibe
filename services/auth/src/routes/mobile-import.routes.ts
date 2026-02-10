import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import {
  authMiddleware,
  verifyAccessToken,
  type AuthRequest,
  type JwtPayload,
} from '@arda/auth-utils';
import { AppError } from '../middleware/error-handler.js';

export const mobileImportRouter = Router();

const createSessionSchema = z.object({
  module: z.enum(['scan-upcs', 'ai-identify']),
});

const postUpcSchema = z.object({
  upc: z.string().trim().regex(/^\d{8,14}$/, 'UPC must be 8-14 digits'),
  sessionToken: z.string().min(16).optional(),
});

const postImageSchema = z.object({
  imageDataUrl: z.string().min(20),
  fileName: z.string().trim().max(200).optional(),
  sessionToken: z.string().min(16).optional(),
});

type MobileImportModule = z.infer<typeof createSessionSchema>['module'];
type MobileImportEvent =
  | {
      id: string;
      sequence: number;
      type: 'upc';
      createdAt: string;
      payload: { upc: string };
    }
  | {
      id: string;
      sequence: number;
      type: 'image';
      createdAt: string;
      payload: { imageDataUrl: string; fileName: string };
    };

interface MobileImportSession {
  id: string;
  tenantId: string;
  userId: string;
  module: MobileImportModule;
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  nextSequence: number;
  events: MobileImportEvent[];
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_EVENTS_PER_SESSION = 250;
const MAX_SESSIONS = 500;
const MAX_IMAGE_DATA_URL_BYTES = 1_500_000;

const sessions = new Map<string, MobileImportSession>();

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeTokenEquals(sessionHash: string, rawToken: string): boolean {
  const candidateHash = hashSessionToken(rawToken);
  return crypto.timingSafeEqual(Buffer.from(sessionHash), Buffer.from(candidateHash));
}

function cleanupExpiredSessions(now = Date.now()): void {
  for (const [id, session] of sessions.entries()) {
    if (new Date(session.expiresAt).getTime() <= now) {
      sessions.delete(id);
    }
  }

  if (sessions.size <= MAX_SESSIONS) return;

  const oldestFirst = [...sessions.values()].sort(
    (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
  );
  const overflow = sessions.size - MAX_SESSIONS;
  for (let i = 0; i < overflow; i += 1) {
    sessions.delete(oldestFirst[i].id);
  }
}

function parseAccessToken(req: any): JwtPayload | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7).trim();
  if (!token) return null;

  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

function getSessionOrThrow(sessionId: string): MobileImportSession {
  cleanupExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) {
    throw new AppError(404, 'Mobile import session not found', 'MOBILE_IMPORT_SESSION_NOT_FOUND');
  }
  return session;
}

function extractSessionToken(req: any): string | null {
  if (typeof req.query?.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  if (typeof req.body?.sessionToken === 'string' && req.body.sessionToken.trim()) {
    return req.body.sessionToken.trim();
  }
  return null;
}

function authorizeSessionAccess(req: any, session: MobileImportSession): void {
  const jwtPayload = parseAccessToken(req);
  if (jwtPayload && jwtPayload.tenantId === session.tenantId) {
    return;
  }

  const sessionToken = extractSessionToken(req);
  if (sessionToken && safeTokenEquals(session.tokenHash, sessionToken)) {
    return;
  }

  throw new AppError(401, 'Unauthorized mobile import session access', 'MOBILE_IMPORT_UNAUTHORIZED');
}

function bumpSessionUpdatedAt(session: MobileImportSession): void {
  session.updatedAt = new Date().toISOString();
}

function appendEvent(session: MobileImportSession, event: MobileImportEvent): MobileImportEvent {
  session.events.push(event);
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
  }
  bumpSessionUpdatedAt(session);
  return event;
}

mobileImportRouter.post('/sessions', authMiddleware, (req: AuthRequest, res, next) => {
  try {
    cleanupExpiredSessions();
    const input = createSessionSchema.parse(req.body ?? {});
    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const rawSessionToken = crypto.randomBytes(24).toString('base64url');

    const session: MobileImportSession = {
      id: sessionId,
      tenantId: req.user!.tenantId,
      userId: req.user!.sub,
      module: input.module,
      tokenHash: hashSessionToken(rawSessionToken),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      nextSequence: 1,
      events: [],
    };

    sessions.set(sessionId, session);

    res.status(201).json({
      sessionId,
      sessionToken: rawSessionToken,
      module: input.module,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(error);
  }
});

mobileImportRouter.get('/sessions/:sessionId', (req, res, next) => {
  try {
    const session = getSessionOrThrow(req.params.sessionId);
    authorizeSessionAccess(req, session);

    const sinceSequenceRaw =
      typeof req.query.sinceSequence === 'string' ? req.query.sinceSequence : undefined;
    const sinceSequence = sinceSequenceRaw ? Number.parseInt(sinceSequenceRaw, 10) : 0;
    const safeSinceSequence = Number.isFinite(sinceSequence) && sinceSequence > 0 ? sinceSequence : 0;
    const events = session.events.filter((event) => event.sequence > safeSinceSequence);

    bumpSessionUpdatedAt(session);

    res.json({
      sessionId: session.id,
      module: session.module,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      nextSequence: session.nextSequence,
      events,
    });
  } catch (error) {
    next(error);
  }
});

mobileImportRouter.post('/sessions/:sessionId/upcs', (req, res, next) => {
  try {
    const input = postUpcSchema.parse(req.body ?? {});
    const session = getSessionOrThrow(req.params.sessionId);
    authorizeSessionAccess(req, session);

    if (session.module !== 'scan-upcs') {
      throw new AppError(400, 'This session is not configured for UPC scanning', 'MOBILE_IMPORT_WRONG_MODULE');
    }

    const event: MobileImportEvent = {
      id: crypto.randomUUID(),
      sequence: session.nextSequence,
      type: 'upc',
      createdAt: new Date().toISOString(),
      payload: {
        upc: input.upc,
      },
    };
    session.nextSequence += 1;

    res.status(202).json({
      accepted: true,
      event: appendEvent(session, event),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(error);
  }
});

mobileImportRouter.post('/sessions/:sessionId/images', (req, res, next) => {
  try {
    const input = postImageSchema.parse(req.body ?? {});
    const session = getSessionOrThrow(req.params.sessionId);
    authorizeSessionAccess(req, session);

    if (session.module !== 'ai-identify') {
      throw new AppError(400, 'This session is not configured for image capture', 'MOBILE_IMPORT_WRONG_MODULE');
    }

    const imageDataUrl = input.imageDataUrl.trim();
    if (!imageDataUrl.startsWith('data:image/')) {
      throw new AppError(400, 'imageDataUrl must be a valid image data URL', 'MOBILE_IMPORT_INVALID_IMAGE');
    }
    if (imageDataUrl.length > MAX_IMAGE_DATA_URL_BYTES) {
      throw new AppError(
        413,
        'Image payload is too large for mobile sync. Please capture a smaller image.',
        'MOBILE_IMPORT_IMAGE_TOO_LARGE',
      );
    }

    const fileName = input.fileName?.trim() || `mobile-capture-${Date.now()}.jpg`;
    const event: MobileImportEvent = {
      id: crypto.randomUUID(),
      sequence: session.nextSequence,
      type: 'image',
      createdAt: new Date().toISOString(),
      payload: {
        imageDataUrl,
        fileName,
      },
    };
    session.nextSequence += 1;

    res.status(202).json({
      accepted: true,
      event: appendEvent(session, event),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    next(error);
  }
});

