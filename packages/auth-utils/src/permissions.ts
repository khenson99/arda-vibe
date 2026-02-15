import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@arda/shared-types';
import type { AuthRequest } from './middleware.js';

// ─── Permission String Type ──────────────────────────────────────────
// Pattern: service:resource:action

export const Permission = {
  // ─── Auth ──────────────────────────────────────────────────────────
  AUTH_USERS_MANAGE: 'auth:users:manage',
  AUTH_PROFILE_READ: 'auth:profile:read',
  AUTH_PROFILE_UPDATE: 'auth:profile:update',

  // ─── Kanban ────────────────────────────────────────────────────────
  KANBAN_LOOPS_READ: 'kanban:loops:read',
  KANBAN_LOOPS_CREATE: 'kanban:loops:create',
  KANBAN_LOOPS_UPDATE: 'kanban:loops:update',
  KANBAN_LOOPS_UPDATE_PARAMETERS: 'kanban:loops:update_parameters',
  KANBAN_CARDS_READ: 'kanban:cards:read',
  KANBAN_CARDS_TRANSITION: 'kanban:cards:transition',
  KANBAN_CARDS_LINK_ORDER: 'kanban:cards:link_order',
  KANBAN_SCAN_READ: 'kanban:scan:read',
  KANBAN_SCAN_TRIGGER: 'kanban:scan:trigger',
  KANBAN_VELOCITY_READ: 'kanban:velocity:read',

  // ─── Orders ────────────────────────────────────────────────────────
  ORDERS_PURCHASE_ORDERS_READ: 'orders:purchase_orders:read',
  ORDERS_PURCHASE_ORDERS_CREATE: 'orders:purchase_orders:create',
  ORDERS_PURCHASE_ORDERS_UPDATE_STATUS: 'orders:purchase_orders:update_status',
  ORDERS_PURCHASE_ORDERS_ADD_LINES: 'orders:purchase_orders:add_lines',
  ORDERS_PURCHASE_ORDERS_RECEIVE: 'orders:purchase_orders:receive',
  ORDERS_WORK_ORDERS_READ: 'orders:work_orders:read',
  ORDERS_WORK_ORDERS_CREATE: 'orders:work_orders:create',
  ORDERS_WORK_ORDERS_UPDATE_STATUS: 'orders:work_orders:update_status',
  ORDERS_WORK_ORDERS_UPDATE_ROUTING: 'orders:work_orders:update_routing',
  ORDERS_WORK_ORDERS_UPDATE_PRODUCTION: 'orders:work_orders:update_production',
  ORDERS_TRANSFER_ORDERS_READ: 'orders:transfer_orders:read',
  ORDERS_TRANSFER_ORDERS_CREATE: 'orders:transfer_orders:create',
  ORDERS_TRANSFER_ORDERS_UPDATE_STATUS: 'orders:transfer_orders:update_status',
  ORDERS_TRANSFER_ORDERS_SHIP: 'orders:transfer_orders:ship',
  ORDERS_TRANSFER_ORDERS_RECEIVE: 'orders:transfer_orders:receive',
  ORDERS_ORDER_QUEUE_READ: 'orders:order_queue:read',
  ORDERS_ORDER_QUEUE_CREATE_PO: 'orders:order_queue:create_po',
  ORDERS_ORDER_QUEUE_CREATE_WO: 'orders:order_queue:create_wo',
  ORDERS_ORDER_QUEUE_CREATE_TO: 'orders:order_queue:create_to',
  ORDERS_ORDER_QUEUE_RISK_SCAN: 'orders:order_queue:risk_scan',
  ORDERS_WORK_CENTERS_READ: 'orders:work_centers:read',
  ORDERS_WORK_CENTERS_CREATE: 'orders:work_centers:create',
  ORDERS_WORK_CENTERS_UPDATE: 'orders:work_centers:update',
  ORDERS_WORK_CENTERS_DELETE: 'orders:work_centers:delete',
  ORDERS_AUDIT_READ: 'orders:audit:read',

  // ─── Catalog ───────────────────────────────────────────────────────
  CATALOG_PARTS_READ: 'catalog:parts:read',
  CATALOG_PARTS_CREATE: 'catalog:parts:create',
  CATALOG_PARTS_UPDATE: 'catalog:parts:update',
  CATALOG_PARTS_DELETE: 'catalog:parts:delete',
  CATALOG_SUPPLIERS_READ: 'catalog:suppliers:read',
  CATALOG_SUPPLIERS_CREATE: 'catalog:suppliers:create',
  CATALOG_SUPPLIERS_UPDATE: 'catalog:suppliers:update',
  CATALOG_SUPPLIERS_LINK_PARTS: 'catalog:suppliers:link_parts',
  CATALOG_CATEGORIES_READ: 'catalog:categories:read',
  CATALOG_CATEGORIES_CREATE: 'catalog:categories:create',
  CATALOG_CATEGORIES_UPDATE: 'catalog:categories:update',
  CATALOG_BOM_READ: 'catalog:bom:read',
  CATALOG_BOM_CREATE: 'catalog:bom:create',
  CATALOG_BOM_DELETE: 'catalog:bom:delete',

  // ─── Catalog Imports (MVP-21) ──────────────────────────────────────
  CATALOG_IMPORTS_READ: 'catalog:imports:read',
  CATALOG_IMPORTS_CREATE: 'catalog:imports:create',
  CATALOG_IMPORTS_REVIEW: 'catalog:imports:review',
  CATALOG_IMPORTS_APPLY: 'catalog:imports:apply',

  // ─── Catalog AI Config (MVP-21) ────────────────────────────────────
  CATALOG_AI_CONFIG_READ: 'catalog:ai_config:read',
  CATALOG_AI_CONFIG_UPDATE: 'catalog:ai_config:update',

  // ─── Notifications ─────────────────────────────────────────────────
  NOTIFICATIONS_READ: 'notifications:notifications:read',
  NOTIFICATIONS_UPDATE: 'notifications:notifications:update',
  NOTIFICATIONS_DELETE: 'notifications:notifications:delete',
  NOTIFICATIONS_PREFERENCES_READ: 'notifications:preferences:read',
  NOTIFICATIONS_PREFERENCES_UPDATE: 'notifications:preferences:update',
} as const;

export type PermissionString = (typeof Permission)[keyof typeof Permission];

// ─── Role → Permission Mapping ───────────────────────────────────────
// tenant_admin is handled at the middleware level (bypass all checks)

export const ROLE_PERMISSIONS: Record<Exclude<UserRole, 'tenant_admin'>, ReadonlySet<PermissionString>> = {
  inventory_manager: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — full operational access
    Permission.KANBAN_LOOPS_READ,
    Permission.KANBAN_LOOPS_CREATE,
    Permission.KANBAN_LOOPS_UPDATE,
    Permission.KANBAN_LOOPS_UPDATE_PARAMETERS,
    Permission.KANBAN_CARDS_READ,
    Permission.KANBAN_CARDS_TRANSITION,
    Permission.KANBAN_CARDS_LINK_ORDER,
    Permission.KANBAN_SCAN_READ,
    Permission.KANBAN_SCAN_TRIGGER,
    Permission.KANBAN_VELOCITY_READ,
    // Orders — work orders, transfer orders, queue ops
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    Permission.ORDERS_WORK_ORDERS_READ,
    Permission.ORDERS_WORK_ORDERS_CREATE,
    Permission.ORDERS_WORK_ORDERS_UPDATE_STATUS,
    Permission.ORDERS_WORK_ORDERS_UPDATE_ROUTING,
    Permission.ORDERS_WORK_ORDERS_UPDATE_PRODUCTION,
    Permission.ORDERS_TRANSFER_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_CREATE,
    Permission.ORDERS_TRANSFER_ORDERS_UPDATE_STATUS,
    Permission.ORDERS_TRANSFER_ORDERS_SHIP,
    Permission.ORDERS_ORDER_QUEUE_READ,
    Permission.ORDERS_ORDER_QUEUE_CREATE_WO,
    Permission.ORDERS_ORDER_QUEUE_CREATE_TO,
    Permission.ORDERS_ORDER_QUEUE_RISK_SCAN,
    Permission.ORDERS_WORK_CENTERS_READ,
    Permission.ORDERS_WORK_CENTERS_CREATE,
    Permission.ORDERS_WORK_CENTERS_UPDATE,
    // Catalog — parts & categories
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_PARTS_CREATE,
    Permission.CATALOG_PARTS_UPDATE,
    Permission.CATALOG_SUPPLIERS_READ,
    Permission.CATALOG_CATEGORIES_READ,
    Permission.CATALOG_CATEGORIES_CREATE,
    Permission.CATALOG_CATEGORIES_UPDATE,
    Permission.CATALOG_BOM_READ,
    Permission.CATALOG_BOM_CREATE,
    // Catalog Imports — create and review
    Permission.CATALOG_IMPORTS_READ,
    Permission.CATALOG_IMPORTS_CREATE,
    Permission.CATALOG_IMPORTS_REVIEW,
    // Catalog AI Config — manage AI provider settings
    Permission.CATALOG_AI_CONFIG_READ,
    Permission.CATALOG_AI_CONFIG_UPDATE,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),

  procurement_manager: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — read + transition + link
    Permission.KANBAN_LOOPS_READ,
    Permission.KANBAN_CARDS_READ,
    Permission.KANBAN_CARDS_TRANSITION,
    Permission.KANBAN_CARDS_LINK_ORDER,
    Permission.KANBAN_SCAN_READ,
    Permission.KANBAN_SCAN_TRIGGER,
    Permission.KANBAN_VELOCITY_READ,
    // Orders — PO full, queue create-po
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    Permission.ORDERS_PURCHASE_ORDERS_CREATE,
    Permission.ORDERS_PURCHASE_ORDERS_UPDATE_STATUS,
    Permission.ORDERS_PURCHASE_ORDERS_ADD_LINES,
    Permission.ORDERS_WORK_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_READ,
    Permission.ORDERS_ORDER_QUEUE_READ,
    Permission.ORDERS_ORDER_QUEUE_CREATE_PO,
    Permission.ORDERS_ORDER_QUEUE_RISK_SCAN,
    // Catalog — parts + suppliers
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_PARTS_CREATE,
    Permission.CATALOG_PARTS_UPDATE,
    Permission.CATALOG_SUPPLIERS_READ,
    Permission.CATALOG_SUPPLIERS_CREATE,
    Permission.CATALOG_SUPPLIERS_UPDATE,
    Permission.CATALOG_SUPPLIERS_LINK_PARTS,
    Permission.CATALOG_CATEGORIES_READ,
    Permission.CATALOG_BOM_READ,
    // Catalog Imports — full access including apply
    Permission.CATALOG_IMPORTS_READ,
    Permission.CATALOG_IMPORTS_CREATE,
    Permission.CATALOG_IMPORTS_REVIEW,
    Permission.CATALOG_IMPORTS_APPLY,
    // Catalog AI Config — manage AI provider settings
    Permission.CATALOG_AI_CONFIG_READ,
    Permission.CATALOG_AI_CONFIG_UPDATE,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),

  receiving_manager: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — read + transition
    Permission.KANBAN_LOOPS_READ,
    Permission.KANBAN_CARDS_READ,
    Permission.KANBAN_CARDS_TRANSITION,
    Permission.KANBAN_SCAN_READ,
    Permission.KANBAN_SCAN_TRIGGER,
    // Orders — receive POs and TOs
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    Permission.ORDERS_PURCHASE_ORDERS_RECEIVE,
    Permission.ORDERS_WORK_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_RECEIVE,
    Permission.ORDERS_ORDER_QUEUE_READ,
    // Catalog — read
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_SUPPLIERS_READ,
    Permission.CATALOG_CATEGORIES_READ,
    Permission.CATALOG_BOM_READ,
    // Catalog Imports — read only
    Permission.CATALOG_IMPORTS_READ,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),

  ecommerce_director: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — read only
    Permission.KANBAN_LOOPS_READ,
    Permission.KANBAN_CARDS_READ,
    Permission.KANBAN_SCAN_READ,
    Permission.KANBAN_VELOCITY_READ,
    // Orders — read only
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    Permission.ORDERS_WORK_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_READ,
    Permission.ORDERS_ORDER_QUEUE_READ,
    // Catalog — read
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_SUPPLIERS_READ,
    Permission.CATALOG_CATEGORIES_READ,
    Permission.CATALOG_BOM_READ,
    // Catalog Imports — read only
    Permission.CATALOG_IMPORTS_READ,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),

  salesperson: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — scan read only (QR code access)
    Permission.KANBAN_SCAN_READ,
    // Orders — PO read only
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    // Catalog — parts & categories read
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_CATEGORIES_READ,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),

  executive: new Set([
    // Auth
    Permission.AUTH_PROFILE_READ,
    Permission.AUTH_PROFILE_UPDATE,
    // Kanban — read + velocity
    Permission.KANBAN_LOOPS_READ,
    Permission.KANBAN_CARDS_READ,
    Permission.KANBAN_SCAN_READ,
    Permission.KANBAN_VELOCITY_READ,
    // Orders — read + audit + risk scan
    Permission.ORDERS_PURCHASE_ORDERS_READ,
    Permission.ORDERS_WORK_ORDERS_READ,
    Permission.ORDERS_TRANSFER_ORDERS_READ,
    Permission.ORDERS_ORDER_QUEUE_READ,
    Permission.ORDERS_ORDER_QUEUE_RISK_SCAN,
    Permission.ORDERS_WORK_CENTERS_READ,
    Permission.ORDERS_AUDIT_READ,
    // Catalog — read
    Permission.CATALOG_PARTS_READ,
    Permission.CATALOG_SUPPLIERS_READ,
    Permission.CATALOG_CATEGORIES_READ,
    Permission.CATALOG_BOM_READ,
    // Catalog Imports — read only
    Permission.CATALOG_IMPORTS_READ,
    // Catalog AI Config — read only (for dashboards)
    Permission.CATALOG_AI_CONFIG_READ,
    // Notifications — own
    Permission.NOTIFICATIONS_READ,
    Permission.NOTIFICATIONS_UPDATE,
    Permission.NOTIFICATIONS_DELETE,
    Permission.NOTIFICATIONS_PREFERENCES_READ,
    Permission.NOTIFICATIONS_PREFERENCES_UPDATE,
  ]),
};

// ─── Permission Check Utility ────────────────────────────────────────

/**
 * Check if a role has a specific permission.
 * tenant_admin always returns true (superuser within tenant).
 */
export function hasPermission(role: UserRole, permission: PermissionString): boolean {
  if (role === 'tenant_admin') return true;
  const rolePerms = ROLE_PERMISSIONS[role];
  return rolePerms ? rolePerms.has(permission) : false;
}

/**
 * Check if a role has ALL of the specified permissions.
 */
export function hasAllPermissions(role: UserRole, permissions: PermissionString[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Check if a role has ANY of the specified permissions.
 */
export function hasAnyPermission(role: UserRole, permissions: PermissionString[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/**
 * Get all permissions for a role.
 * Returns all permission strings for tenant_admin.
 */
export function getPermissionsForRole(role: UserRole): PermissionString[] {
  if (role === 'tenant_admin') {
    return Object.values(Permission);
  }
  const rolePerms = ROLE_PERMISSIONS[role];
  return rolePerms ? [...rolePerms] : [];
}

// ─── Express Middleware ──────────────────────────────────────────────

/**
 * Express middleware that requires the authenticated user to have a specific permission.
 * Must be used AFTER authMiddleware (req.user must be set).
 *
 * tenant_admin bypasses all permission checks.
 *
 * Usage:
 *   router.post('/', authMiddleware, requirePermission(Permission.KANBAN_LOOPS_CREATE), handler);
 */
export function requirePermission(...permissions: PermissionString[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = authReq.user.role as UserRole;

    if (!hasAllPermissions(role, permissions)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
        role,
      });
      return;
    }

    next();
  };
}

/**
 * Express middleware that requires the authenticated user to have ANY of the specified permissions.
 *
 * Usage:
 *   router.get('/', authMiddleware, requireAnyPermission(
 *     Permission.ORDERS_PURCHASE_ORDERS_READ,
 *     Permission.ORDERS_WORK_ORDERS_READ
 *   ), handler);
 */
export function requireAnyPermission(...permissions: PermissionString[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = authReq.user.role as UserRole;

    if (!hasAnyPermission(role, permissions)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
        role,
      });
      return;
    }

    next();
  };
}
