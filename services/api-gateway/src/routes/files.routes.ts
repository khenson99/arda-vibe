/**
 * File upload / download routes.
 *
 * All routes require authentication. The tenantId is sourced from the
 * JWT payload (`req.user.tenantId`) set by the auth middleware.
 *
 * Routes:
 *   POST   /files/upload       — upload a single file (multipart)
 *   GET    /files/:key/url     — get a signed download URL (15 min default)
 *   DELETE /files/:key         — delete a file
 *   GET    /files              — list files for the tenant (optional ?prefix=)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware, type AuthRequest } from '@arda/auth-utils';
import { createLogger } from '@arda/config';
import { uploadSingle } from '../middleware/upload.middleware.js';
import {
  FileService,
  FileSizeError,
  TenantAccessError,
} from '../services/file.service.js';

const log = createLogger('files-routes');
const fileService = new FileService();
const router = Router();

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// All file routes require a valid JWT
router.use(authMiddleware);

// ─── POST /files/upload ──────────────────────────────────────────────
router.post('/upload', (req: Request, res: Response, next) => {
  // Run multer first, then handle the upload in the callback
  uploadSingle(req, res, async (multerErr: unknown) => {
    try {
      if (multerErr) {
        if (multerErr instanceof multer.MulterError) {
          const status =
            multerErr.code === 'LIMIT_FILE_SIZE' ? 413 :
            multerErr.code === 'LIMIT_UNEXPECTED_FILE' ? 415 :
            400;
          res.status(status).json({
            success: false,
            error: multerErr.message,
          });
          return;
        }
        throw multerErr;
      }

      const authReq = req as AuthRequest;
      const tenantId = authReq.user?.tenantId;
      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Missing tenant context' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'No file provided' });
        return;
      }

      const folder = firstString(req.body?.folder) || undefined;

      const metadata = await fileService.upload(
        tenantId,
        {
          buffer: req.file.buffer,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        },
        folder,
      );

      // Generate a signed URL so the client can immediately use the file
      const url = await fileService.getSignedUrl(tenantId, metadata.key);

      res.status(201).json({
        success: true,
        data: {
          key: metadata.key,
          url,
          metadata,
        },
      });
    } catch (err) {
      handleError(res, err);
    }
  });
});

// ─── GET /files/:key/url ─────────────────────────────────────────────
// The :key param uses a wildcard to support keys with slashes
// (e.g. "tenantId/folder/uuid-filename.pdf").
router.get('/:key(*)/url', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      res.status(401).json({ success: false, error: 'Missing tenant context' });
      return;
    }

    const key = firstString(req.params.key);
    if (!key) {
      res.status(400).json({ success: false, error: 'Missing file key' });
      return;
    }

    const expiresInRaw = firstString(req.query.expiresIn as string | string[] | undefined);
    const expiresIn = expiresInRaw
      ? parseInt(expiresInRaw, 10)
      : undefined;

    const url = await fileService.getSignedUrl(tenantId, key, expiresIn);

    res.json({
      success: true,
      data: { url, expiresIn: expiresIn ?? 900 },
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── DELETE /files/:key ──────────────────────────────────────────────
router.delete('/:key(*)', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      res.status(401).json({ success: false, error: 'Missing tenant context' });
      return;
    }

    const key = firstString(req.params.key);
    if (!key) {
      res.status(400).json({ success: false, error: 'Missing file key' });
      return;
    }
    await fileService.delete(tenantId, key);

    res.json({ success: true, data: null });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── GET /files ──────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      res.status(401).json({ success: false, error: 'Missing tenant context' });
      return;
    }

    const prefix = firstString(req.query.prefix as string | string[] | undefined) || undefined;
    const files = await fileService.list(tenantId, prefix);

    res.json({
      success: true,
      data: files,
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ─── Error Handler ───────────────────────────────────────────────────

function handleError(res: Response, err: unknown): void {
  if (err instanceof FileSizeError) {
    res.status(413).json({ success: false, error: err.message });
    return;
  }

  if (err instanceof TenantAccessError) {
    res.status(403).json({ success: false, error: err.message });
    return;
  }

  log.error({ err }, 'Unexpected error in file route');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

export { router as filesRouter };
