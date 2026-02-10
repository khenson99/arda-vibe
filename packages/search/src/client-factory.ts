/**
 * @arda/search — Client factory
 *
 * Creates the appropriate SearchClient implementation based on
 * whether an Elasticsearch URL is provided. Falls back to an
 * in-memory MockSearchClient for local development and testing.
 */

import type { SearchClient } from './types.js';
import { ElasticsearchSearchClient } from './elasticsearch-client.js';
import { MockSearchClient } from './mock-client.js';

/**
 * Create a SearchClient instance.
 *
 * @param elasticsearchUrl - Elasticsearch node URL (e.g., "http://localhost:9200").
 *   When provided, returns an ElasticsearchSearchClient.
 *   When omitted or empty, returns a MockSearchClient.
 * @returns A SearchClient implementation
 */
export function createSearchClient(elasticsearchUrl?: string): SearchClient {
  if (elasticsearchUrl) {
    return new ElasticsearchSearchClient({ node: elasticsearchUrl });
  }

  return new MockSearchClient();
}
