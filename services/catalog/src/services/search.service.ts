/**
 * Catalog Search Service
 *
 * Wraps the @arda/search SearchClient to provide tenant-isolated
 * search operations for parts and suppliers. All queries are
 * automatically scoped to the caller's tenantId.
 */

import type { SearchClient, SearchQuery, SearchResult, SearchHit } from '@arda/search';
import { PARTS_INDEX, SUPPLIERS_INDEX } from '@arda/search';

// ─── Types ───────────────────────────────────────────────────────────

export interface Pagination {
  page: number;
  limit: number;
}

export interface PartSearchFilters {
  category?: string;
  supplierId?: string;
  status?: string;
  manufacturer?: string;
}

export interface SupplierSearchFilters {
  status?: string;
  category?: string;
  city?: string;
  country?: string;
}

export interface PaginatedSearchResult<T = Record<string, unknown>> {
  hits: SearchHit<T>[];
  total: number;
  page: number;
  limit: number;
}

// ─── Service ─────────────────────────────────────────────────────────

export class SearchService {
  constructor(private readonly client: SearchClient) {}

  /**
   * Search parts scoped to a tenant.
   */
  async searchParts(
    tenantId: string,
    query: string,
    filters: PartSearchFilters = {},
    pagination: Pagination = { page: 1, limit: 20 },
  ): Promise<PaginatedSearchResult> {
    const { page, limit } = pagination;
    const from = (page - 1) * limit;

    const searchFilters: Record<string, unknown> = { tenantId };
    if (filters.category) searchFilters.category = filters.category;
    if (filters.supplierId) searchFilters.supplierId = filters.supplierId;
    if (filters.status) searchFilters.status = filters.status;
    if (filters.manufacturer) searchFilters['manufacturer.keyword'] = filters.manufacturer;

    const searchQuery: SearchQuery = {
      query,
      filters: searchFilters,
      from,
      size: limit,
      highlight: true,
    };

    const result: SearchResult = await this.client.search(PARTS_INDEX, searchQuery);

    return {
      hits: result.hits,
      total: result.total,
      page,
      limit,
    };
  }

  /**
   * Search suppliers scoped to a tenant.
   */
  async searchSuppliers(
    tenantId: string,
    query: string,
    filters: SupplierSearchFilters = {},
    pagination: Pagination = { page: 1, limit: 20 },
  ): Promise<PaginatedSearchResult> {
    const { page, limit } = pagination;
    const from = (page - 1) * limit;

    const searchFilters: Record<string, unknown> = { tenantId };
    if (filters.status) searchFilters.status = filters.status;
    if (filters.category) searchFilters.categories = filters.category;
    if (filters.city) searchFilters['address.city'] = filters.city;
    if (filters.country) searchFilters['address.country'] = filters.country;

    const searchQuery: SearchQuery = {
      query,
      filters: searchFilters,
      from,
      size: limit,
      highlight: true,
    };

    const result: SearchResult = await this.client.search(SUPPLIERS_INDEX, searchQuery);

    return {
      hits: result.hits,
      total: result.total,
      page,
      limit,
    };
  }

  /**
   * Index a part document for search.
   */
  async indexPart(tenantId: string, part: Record<string, unknown>): Promise<void> {
    const id = part.id as string;
    if (!id) throw new Error('Part must have an id');

    await this.client.index(PARTS_INDEX, id, {
      ...part,
      tenantId,
    });
  }

  /**
   * Index a supplier document for search.
   */
  async indexSupplier(tenantId: string, supplier: Record<string, unknown>): Promise<void> {
    const id = supplier.id as string;
    if (!id) throw new Error('Supplier must have an id');

    await this.client.index(SUPPLIERS_INDEX, id, {
      ...supplier,
      tenantId,
    });
  }

  /**
   * Remove a part from the search index.
   */
  async deletePart(tenantId: string, partId: string): Promise<void> {
    // Verify tenant ownership by searching first
    const result = await this.client.search(PARTS_INDEX, {
      query: '',
      filters: { tenantId, _id: partId },
      size: 1,
    });

    // Only delete if the document belongs to this tenant
    if (result.total > 0) {
      await this.client.delete(PARTS_INDEX, partId);
    }
  }
}
