/**
 * Order Search Service
 *
 * Wraps the @arda/search SearchClient to provide tenant-isolated
 * search operations for orders. Supports full-text search across
 * order numbers, customer/supplier names, and notes, plus filtering
 * by status, priority, and date ranges.
 */

import type { SearchClient, SearchQuery, SearchResult, SearchHit } from '@arda/search';
import { ORDERS_INDEX } from '@arda/search';

// ─── Types ───────────────────────────────────────────────────────────

export interface Pagination {
  page: number;
  limit: number;
}

export interface OrderSearchFilters {
  status?: string;
  priority?: string;
  supplierId?: string;
  customerId?: string;
  riskLevel?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface PaginatedSearchResult<T = Record<string, unknown>> {
  hits: SearchHit<T>[];
  total: number;
  page: number;
  limit: number;
}

// ─── Service ─────────────────────────────────────────────────────────

export class OrderSearchService {
  constructor(private readonly client: SearchClient) {}

  /**
   * Search orders scoped to a tenant.
   *
   * Date range filters (dateFrom / dateTo) are applied as range queries
   * on the createdAt field. The SearchClient's filter mechanism uses
   * term queries by default, so we build a composite filter map that
   * the Elasticsearch client converts to the bool/filter clause.
   */
  async searchOrders(
    tenantId: string,
    query: string,
    filters: OrderSearchFilters = {},
    pagination: Pagination = { page: 1, limit: 20 },
  ): Promise<PaginatedSearchResult> {
    const { page, limit } = pagination;
    const from = (page - 1) * limit;

    // Build term-level filters (always include tenant isolation)
    const searchFilters: Record<string, unknown> = { tenantId };
    if (filters.status) searchFilters.status = filters.status;
    if (filters.priority) searchFilters.priority = filters.priority;
    if (filters.supplierId) searchFilters.supplierId = filters.supplierId;
    if (filters.customerId) searchFilters.customerId = filters.customerId;
    if (filters.riskLevel) searchFilters.riskLevel = filters.riskLevel;

    // Date range: pack into a single filter key that the client can interpret.
    // The ElasticsearchSearchClient builds term filters from the filters map.
    // For date ranges we include them as structured values that the bool/filter
    // clause can pick up as range queries. The MockSearchClient performs a
    // simple equality check, so date-range filtering is best-effort there.
    if (filters.dateFrom || filters.dateTo) {
      const rangeValue: Record<string, string> = {};
      if (filters.dateFrom) rangeValue.gte = filters.dateFrom;
      if (filters.dateTo) rangeValue.lte = filters.dateTo;
      searchFilters.createdAt = rangeValue;
    }

    const searchQuery: SearchQuery = {
      query,
      filters: searchFilters,
      from,
      size: limit,
      sort: [{ field: 'createdAt', order: 'desc' }],
      highlight: true,
    };

    const result: SearchResult = await this.client.search(ORDERS_INDEX, searchQuery);

    return {
      hits: result.hits,
      total: result.total,
      page,
      limit,
    };
  }

  /**
   * Index a full order document for search.
   */
  async indexOrder(tenantId: string, order: Record<string, unknown>): Promise<void> {
    const id = order.id as string;
    if (!id) throw new Error('Order must have an id');

    await this.client.index(ORDERS_INDEX, id, {
      ...order,
      tenantId,
    });
  }

  /**
   * Partially update an order's search index entry.
   *
   * Reads the current document, merges the partial update, and re-indexes.
   * This is safe because the SearchClient.index call is an upsert.
   */
  async updateOrderIndex(
    tenantId: string,
    orderId: string,
    partialUpdate: Record<string, unknown>,
  ): Promise<void> {
    // Fetch the existing document to merge
    const result = await this.client.search(ORDERS_INDEX, {
      query: '',
      filters: { tenantId, _id: orderId },
      size: 1,
    });

    const existing = result.hits[0]?.source ?? {};

    await this.client.index(ORDERS_INDEX, orderId, {
      ...existing,
      ...partialUpdate,
      tenantId,
      updatedAt: new Date().toISOString(),
    });
  }
}
