import * as React from "react";
import { fetchCrossLocationMatrix, fetchCrossLocationSummary } from "@/lib/api-client";
import type { CrossLocationMatrixResponse, CrossLocationSummary } from "@/types";

interface UseCrossLocationMatrixParams {
  page?: number;
  pageSize?: number;
  partId?: string;
  facilityId?: string;
}

interface UseCrossLocationMatrixResult {
  data: CrossLocationMatrixResponse | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useCrossLocationMatrix(
  token: string | null,
  params?: UseCrossLocationMatrixParams,
): UseCrossLocationMatrixResult {
  const [data, setData] = React.useState<CrossLocationMatrixResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  const fetchData = React.useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetchCrossLocationMatrix(token, params);
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch cross-location matrix"));
    } finally {
      setLoading(false);
    }
  }, [token, params?.page, params?.pageSize, params?.partId, params?.facilityId]);

  React.useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

interface UseCrossLocationSummaryResult {
  data: CrossLocationSummary | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useCrossLocationSummary(token: string | null): UseCrossLocationSummaryResult {
  const [data, setData] = React.useState<CrossLocationSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  const fetchData = React.useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetchCrossLocationSummary(token);
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch cross-location summary"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  React.useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
