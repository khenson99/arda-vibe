/**
 * FileService — Wraps StorageAdapter with tenant-scoped file operations.
 *
 * All storage keys are prefixed with the tenant ID to enforce isolation.
 * File size limits: images < 10 MB, documents < 50 MB.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createStorageAdapter } from '@arda/storage';
import type { StorageAdapter, FileMetadata } from '@arda/storage';
import { config, createLogger } from '@arda/config';

const log = createLogger('file-service');

// ─── Size Limits ──────────────────────────────────────────────────────
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50 MB

const IMAGE_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const DOCUMENT_MIMETYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
]);

// ─── Helpers ──────────────────────────────────────────────────────────

/** Make a filename URL-safe: lowercase, replace spaces/specials with hyphens. */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]/g, '-') // replace non-safe chars with hyphens
    .replace(/-{2,}/g, '-')          // collapse multiple hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens
}

/** Determine the per-type size limit for a given MIME type. */
function getMaxSizeForMimetype(mimetype: string): number {
  if (IMAGE_MIMETYPES.has(mimetype)) return MAX_IMAGE_SIZE;
  if (DOCUMENT_MIMETYPES.has(mimetype)) return MAX_DOCUMENT_SIZE;
  // Fallback to document limit for any allowed type
  return MAX_DOCUMENT_SIZE;
}

// ─── File Upload Descriptor ───────────────────────────────────────────

export interface UploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

// ─── FileService ──────────────────────────────────────────────────────

export class FileService {
  private storage: StorageAdapter;

  constructor() {
    this.storage = createStorageAdapter({
      provider: config.AWS_ACCESS_KEY_ID ? 's3' : 'local',
      s3: config.AWS_ACCESS_KEY_ID
        ? {
            bucket: config.AWS_S3_BUCKET,
            region: config.AWS_REGION,
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
      local: !config.AWS_ACCESS_KEY_ID
        ? {
            basePath: path.resolve('uploads'),
            baseUrl: '/uploads',
          }
        : undefined,
    });

    log.info(
      { provider: config.AWS_ACCESS_KEY_ID ? 's3' : 'local' },
      'FileService initialized',
    );
  }

  /**
   * Upload a file scoped to a tenant.
   *
   * Key format: `{tenantId}/{folder}/{uuid}-{sanitized-originalname}`
   */
  async upload(
    tenantId: string,
    file: UploadFile,
    folder = 'general',
  ): Promise<FileMetadata> {
    // Validate size against type-specific limits
    const maxSize = getMaxSizeForMimetype(file.mimetype);
    if (file.size > maxSize) {
      const limitMb = Math.round(maxSize / (1024 * 1024));
      throw new FileSizeError(
        `File exceeds the ${limitMb} MB limit for ${file.mimetype}`,
      );
    }

    const safeName = sanitizeFilename(file.originalname);
    const uniqueId = randomUUID();
    const key = `${tenantId}/${folder}/${uniqueId}-${safeName}`;

    log.debug({ tenantId, key, size: file.size, mimetype: file.mimetype }, 'Uploading file');

    await this.storage.upload(key, file.buffer, {
      contentType: file.mimetype,
      metadata: {
        tenantId,
        originalName: file.originalname,
      },
    });

    return {
      key,
      size: file.size,
      contentType: file.mimetype,
      lastModified: new Date(),
      metadata: {
        tenantId,
        originalName: file.originalname,
      },
    };
  }

  /**
   * Generate a pre-signed download URL for a tenant-scoped file.
   *
   * @param expiresIn - Expiration in seconds (default: 900 = 15 minutes)
   */
  async getSignedUrl(
    tenantId: string,
    key: string,
    expiresIn = 900,
  ): Promise<string> {
    this.assertTenantOwnership(tenantId, key);
    return this.storage.getSignedUrl(key, expiresIn);
  }

  /** Delete a file, enforcing tenant ownership of the key. */
  async delete(tenantId: string, key: string): Promise<void> {
    this.assertTenantOwnership(tenantId, key);
    log.debug({ tenantId, key }, 'Deleting file');
    await this.storage.delete(key);
  }

  /**
   * List files for a tenant under an optional prefix.
   *
   * The prefix is always scoped to the tenant directory to prevent
   * cross-tenant enumeration.
   */
  async list(tenantId: string, prefix?: string): Promise<FileMetadata[]> {
    const scopedPrefix = prefix
      ? `${tenantId}/${prefix}`
      : `${tenantId}/`;

    // StorageAdapter may not have a native `list` method; if the adapter
    // exposes one we use it, otherwise return an empty array. The S3
    // adapter has list via the AWS SDK; the local adapter could walk the
    // directory. This is left as a pass-through for now.
    if ('list' in this.storage && typeof (this.storage as any).list === 'function') {
      return (this.storage as any).list(scopedPrefix) as Promise<FileMetadata[]>;
    }

    log.warn('Storage adapter does not support list — returning empty array');
    return [];
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /** Ensure the key belongs to the given tenant to prevent cross-tenant access. */
  private assertTenantOwnership(tenantId: string, key: string): void {
    if (!key.startsWith(`${tenantId}/`)) {
      throw new TenantAccessError('Access denied: file does not belong to this tenant');
    }
  }
}

// ─── Custom Error Classes ─────────────────────────────────────────────

export class FileSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSizeError';
  }
}

export class TenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAccessError';
  }
}
