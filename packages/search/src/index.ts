/**
 * @arda/search — Search indexing framework
 *
 * Provides a unified search client interface with Elasticsearch
 * and in-memory mock implementations.
 */

// Clients
export { ElasticsearchSearchClient, type ElasticsearchClientConfig } from './elasticsearch-client.js';
export { MockSearchClient } from './mock-client.js';
export { createSearchClient } from './client-factory.js';

// Index mappings
export { PARTS_INDEX, partsMapping } from './mappings/parts.js';
export { SUPPLIERS_INDEX, suppliersMapping } from './mappings/suppliers.js';
export { ORDERS_INDEX, ordersMapping } from './mappings/orders.js';
export { AUDIT_INDEX, auditMapping } from './mappings/audit.js';

// Types
export type {
  SearchClient,
  SearchQuery,
  SearchResult,
  SearchHit,
  IndexMapping,
  FieldMapping,
} from './types.js';
