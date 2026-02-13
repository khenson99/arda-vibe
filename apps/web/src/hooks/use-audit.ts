import { useState, useEffect, useCallback, useRef } from "react";
import {
  isUnauthorized,
  parseApiError,
  fetchAuditLogs,
  fetchAuditSummary,
  fetchAuditActions,
  fetchAuditEntityTypes,
  fetchEntityActivity,
} from "@/lib/api-client";
import type {
  AuditLogEntry,
  AuditPagination,
  AuditListFilters,
  AuditSummaryData,
  AuditSummaryFilters,
} from "@/types";

/* ── useAuditLogs — paginated audit list with filters ──────── */

interface UseAuditLogsOptions {
  token: string;
  filters: AuditListFilters;
  onUnauthorized: () => void;
}

export function useAuditLogs({ token, filters, onUnauthorized }: UseAuditLogsOptions) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [pagination, setPagination] = useState<AuditPagination>({
    page: 1,
    limit: 50,
    total: 0,
    pages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchAuditLogs(token, filters);
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      setEntries(res.data);
      setPagination(res.pagination);
    } catch (err) {
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      if (isUnauthorized(err)) { onUnauthorized(); return; }
      setError(parseApiError(err));
    } finally {
      if (id === fetchIdRef.current && isMountedRef.current) setLoading(false);
    }
  }, [token, filters, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  return { entries, pagination, loading, error, refresh: load };
}

/* ── useAuditSummary ───────────────────────────────────────── */

interface UseAuditSummaryOptions {
  token: string;
  filters: AuditSummaryFilters;
  onUnauthorized: () => void;
}

export function useAuditSummary({ token, filters, onUnauthorized }: UseAuditSummaryOptions) {
  const [summary, setSummary] = useState<AuditSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchAuditSummary(token, filters);
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      setSummary(res.data);
    } catch (err) {
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      if (isUnauthorized(err)) { onUnauthorized(); return; }
      setError(parseApiError(err));
    } finally {
      if (id === fetchIdRef.current && isMountedRef.current) setLoading(false);
    }
  }, [token, filters, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  return { summary, loading, error, refresh: load };
}

/* ── useAuditFilterOptions — fetch distinct actions + entity types ── */

interface UseAuditFilterOptionsResult {
  actions: string[];
  entityTypes: string[];
  loading: boolean;
}

export function useAuditFilterOptions(
  token: string,
  onUnauthorized: () => void,
): UseAuditFilterOptionsResult {
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [actionsRes, typesRes] = await Promise.all([
          fetchAuditActions(token),
          fetchAuditEntityTypes(token),
        ]);
        if (!isMountedRef.current) return;
        setActions(actionsRes.data);
        setEntityTypes(typesRes.data);
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) { onUnauthorized(); return; }
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    }
    void load();
  }, [token, onUnauthorized]);

  return { actions, entityTypes, loading };
}

/* ── useEntityActivity — entity-scoped audit trail ─────────── */

interface UseEntityActivityOptions {
  token: string;
  entityType: string;
  entityId: string;
  onUnauthorized: () => void;
  pageSize?: number;
}

export function useEntityActivity({
  token,
  entityType,
  entityId,
  onUnauthorized,
  pageSize = 20,
}: UseEntityActivityOptions) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [pagination, setPagination] = useState<AuditPagination>({
    page: 1,
    limit: pageSize,
    total: 0,
    pages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!entityId || !entityType) return;
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await fetchEntityActivity(token, entityType, entityId, page, pageSize);
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      setEntries(res.data);
      setPagination(res.pagination);
    } catch (err) {
      if (id !== fetchIdRef.current || !isMountedRef.current) return;
      if (isUnauthorized(err)) { onUnauthorized(); return; }
      setError(parseApiError(err));
    } finally {
      if (id === fetchIdRef.current && isMountedRef.current) setLoading(false);
    }
  }, [token, entityType, entityId, page, pageSize, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  return { entries, pagination, loading, error, page, setPage, refresh: load };
}
