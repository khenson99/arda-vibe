/**
 * Multer middleware configuration for file uploads.
 *
 * Uses memory storage (buffers) so files can be forwarded directly
 * to the StorageAdapter without touching the local disk.
 *
 * NOTE: The `multer` package must be added to api-gateway dependencies:
 *   npm install multer
 *   npm install -D @types/multer
 */

import multer, { type FileFilterCallback } from 'multer';
import type { Request } from 'express';

// ─── Allowed MIME Types ──────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
]);

const ALLOWED_TYPES = new Set([...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOCUMENT_TYPES]);

// ─── Size Limit ──────────────────────────────────────────────────────
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (outer limit; type-specific limits enforced in FileService)

// ─── File Filter ─────────────────────────────────────────────────────
function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void {
  if (ALLOWED_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `File type "${file.mimetype}" is not allowed. Accepted: jpg, png, gif, webp, pdf, xlsx, csv, docx`,
      ),
    );
  }
}

// ─── Multer Instance ─────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
  fileFilter,
});

// ─── Exported Middleware ─────────────────────────────────────────────

/** Accept a single file under the field name `file`. */
export const uploadSingle = upload.single('file');

/** Accept up to 10 files under the field name `files`. */
export const uploadMultiple = upload.array('files', 10);
