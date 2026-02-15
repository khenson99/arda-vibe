/**
 * @arda/load-tests -- Tag Helper
 *
 * Maps k6 requests to SLO tags (api_category, workflow, service).
 * Ensures consistent tagging aligned with thresholds.json and
 * Prometheus metric labels in packages/observability/src/metrics.ts.
 *
 * Usage:
 *   import { tagRequest, getTags } from '../helpers/tags.js';
 *   const params = tagRequest('/api/catalog/parts/123', 'GET');
 *   const res = http.get(url, params);
 *
 * @see docs/ops/slo-budgets.md section 9 (Prometheus Metric Label Guidance)
 * @see tests/load/thresholds.json (threshold definitions)
 */

// ---------------------------------------------------------------------------
// Route -> API Category mapping
// ---------------------------------------------------------------------------

const CATEGORY_RULES = [
  // Health checks
  { pattern: /^\/health/, method: 'GET', category: 'health' },

  // Auth endpoints
  { pattern: /^\/api\/auth\//, method: '*', category: 'auth' },

  // Workflow transitions
  { pattern: /\/transition$/, method: 'POST', category: 'workflow_transition' },
  { pattern: /\/convert$/, method: 'POST', category: 'workflow_transition' },

  // Background scans
  { pattern: /\/risk-scan/, method: '*', category: 'background_scan' },
  { pattern: /\/order-queue/, method: 'POST', category: 'background_scan' },

  // Write operations (must come after more specific POST rules)
  { pattern: /^\/api\//, method: 'POST', category: 'write' },
  { pattern: /^\/api\//, method: 'PUT', category: 'write' },
  { pattern: /^\/api\//, method: 'PATCH', category: 'write' },
  { pattern: /^\/api\//, method: 'DELETE', category: 'write' },

  // Read single (paths ending with an ID-like segment)
  {
    pattern: /^\/api\/.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    method: 'GET',
    category: 'read_single',
  },
  { pattern: /^\/scan\//, method: 'GET', category: 'read_single' },

  // Read list (GET on collection endpoints)
  { pattern: /^\/api\//, method: 'GET', category: 'read_list' },
];

// ---------------------------------------------------------------------------
// Route -> Workflow mapping (FR-01, FR-02, FR-03)
// ---------------------------------------------------------------------------

const WORKFLOW_RULES = [
  { pattern: /^\/api\/catalog\//, workflow: 'fr01' },
  { pattern: /^\/api\/kanban\//, workflow: 'fr02' },
  { pattern: /^\/scan\//, workflow: 'fr02' },
  { pattern: /^\/api\/orders\//, workflow: 'fr03' },
];

// ---------------------------------------------------------------------------
// Route -> Service mapping
// ---------------------------------------------------------------------------

const SERVICE_RULES = [
  { pattern: /^\/api\/auth\//, service: 'auth' },
  { pattern: /^\/api\/tenants\//, service: 'auth' },
  { pattern: /^\/api\/catalog\//, service: 'catalog' },
  { pattern: /^\/api\/kanban\//, service: 'kanban' },
  { pattern: /^\/scan\//, service: 'kanban' },
  { pattern: /^\/api\/orders\//, service: 'orders' },
  { pattern: /^\/api\/notifications\//, service: 'notifications' },
  { pattern: /^\/health/, service: 'api-gateway' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive SLO tags for a given route and HTTP method.
 *
 * @param {string} route - Request path (e.g., '/api/catalog/parts/123')
 * @param {string} method - HTTP method (e.g., 'GET', 'POST')
 * @returns {{ api_category: string, workflow: string|undefined, service: string|undefined }}
 */
export function getTags(route, method) {
  const upperMethod = (method || 'GET').toUpperCase();

  // Resolve api_category
  let api_category = 'unknown';
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(route) && (rule.method === '*' || rule.method === upperMethod)) {
      api_category = rule.category;
      break;
    }
  }

  // Resolve workflow
  let workflow;
  for (const rule of WORKFLOW_RULES) {
    if (rule.pattern.test(route)) {
      workflow = rule.workflow;
      break;
    }
  }

  // Resolve service
  let service;
  for (const rule of SERVICE_RULES) {
    if (rule.pattern.test(route)) {
      service = rule.service;
      break;
    }
  }

  const tags = { api_category };
  if (workflow) tags.workflow = workflow;
  if (service) tags.service = service;

  return tags;
}

/**
 * Build k6 request params with SLO tags applied.
 *
 * Merges SLO tags into the `tags` property of k6 request params.
 * Existing tags in `extraParams` are preserved; SLO tags take precedence.
 *
 * @param {string} route - Request path
 * @param {string} method - HTTP method
 * @param {object} [extraParams] - Additional k6 params (headers, etc.)
 * @returns {object} k6 params with tags applied
 *
 * @example
 *   import http from 'k6/http';
 *   import { tagRequest } from '../helpers/tags.js';
 *
 *   export default function () {
 *     const url = `${__ENV.BASE_URL}/api/catalog/parts`;
 *     const params = tagRequest('/api/catalog/parts', 'GET', {
 *       headers: { Authorization: `Bearer ${__ENV.AUTH_TOKEN}` },
 *     });
 *     http.get(url, params);
 *   }
 */
export function tagRequest(route, method, extraParams) {
  const sloTags = getTags(route, method);
  const params = extraParams ? Object.assign({}, extraParams) : {};
  params.tags = Object.assign({}, params.tags || {}, sloTags);
  return params;
}
