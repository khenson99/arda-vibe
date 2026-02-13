import { useState, useCallback, useRef, useEffect } from "react";
import {
  isUnauthorized,
  parseApiError,
  exportAuditSync,
  exportAuditAsync,
  pollExportJob,
  downloadExportFile,
  runIntegrityCheck,
  ApiError,
} from "@/lib/api-client";
import type {
  AuditExportFormat,
  AuditExportJobResponse,
  AuditListFilters,
  AuditIntegrityCheckResult,
} from "@/types";

/* ── Helper: trigger browser download from Blob ──────────────── */

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/* ── useAuditExport ──────────────────────────────────────────── */

export type ExportPhase =
  | "idle"
  | "starting"
  | "downloading"
  | "polling"
  | "completed"
  | "error";

interface UseAuditExportOptions {
  token: string;
  onUnauthorized: () => void;
}

interface UseAuditExportResult {
  phase: ExportPhase;
  error: string | null;
  progress: number | null;
  startExport: (
    format: AuditExportFormat,
    filters: Omit<AuditListFilters, "page" | "limit">,
    includeArchived?: boolean,
  ) => void;
  reset: () => void;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150; // 5 minutes max polling

export function useAuditExport({
  token,
  onUnauthorized,
}: UseAuditExportOptions): UseAuditExportResult {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const isMountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setProgress(null);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startExport = useCallback(
    async (
      format: AuditExportFormat,
      filters: Omit<AuditListFilters, "page" | "limit">,
      includeArchived?: boolean,
    ) => {
      if (!isMountedRef.current) return;
      setPhase("starting");
      setError(null);
      setProgress(null);

      // First try async export; fall back to sync if 404
      try {
        const job = await exportAuditAsync(token, format, filters, includeArchived);
        if (!isMountedRef.current) return;

        // Async endpoint exists — start polling
        setPhase("polling");
        setProgress(job.progress ?? 0);
        await pollForCompletion(job.jobId);
        return;
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) { onUnauthorized(); return; }

        // If async endpoint returns 404, fall back to sync
        const is404 = err instanceof ApiError && err.status === 404;
        if (!is404) {
          setPhase("error");
          setError(parseApiError(err));
          return;
        }
      }

      // Sync fallback
      try {
        setPhase("downloading");
        const { blob, filename } = await exportAuditSync(
          token,
          format,
          filters,
          includeArchived,
        );
        if (!isMountedRef.current) return;
        triggerBlobDownload(blob, filename);
        setPhase("completed");
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) { onUnauthorized(); return; }
        setPhase("error");
        setError(parseApiError(err));
      }
    },
    [token, onUnauthorized],
  );

  /* ── Polling loop ─────────────────────────────────────────── */

  const pollForCompletion = useCallback(
    async (jobId: string, pollCount = 0) => {
      if (!isMountedRef.current) return;

      if (pollCount >= MAX_POLLS) {
        setPhase("error");
        setError("Export timed out. Please try again.");
        return;
      }

      try {
        const job: AuditExportJobResponse = await pollExportJob(token, jobId);
        if (!isMountedRef.current) return;
        setProgress(job.progress ?? null);

        if (job.status === "completed" && job.downloadUrl) {
          setPhase("downloading");
          const { blob, filename } = await downloadExportFile(
            token,
            job.downloadUrl,
          );
          if (!isMountedRef.current) return;
          triggerBlobDownload(blob, filename);
          setPhase("completed");
          return;
        }

        if (job.status === "failed") {
          setPhase("error");
          setError(job.error ?? "Export failed on the server.");
          return;
        }

        // Still pending/processing — schedule next poll
        pollTimerRef.current = setTimeout(
          () => void pollForCompletion(jobId, pollCount + 1),
          POLL_INTERVAL_MS,
        );
      } catch (err) {
        if (!isMountedRef.current) return;
        if (isUnauthorized(err)) { onUnauthorized(); return; }
        setPhase("error");
        setError(parseApiError(err));
      }
    },
    [token, onUnauthorized],
  );

  return { phase, error, progress, startExport, reset };
}

/* ── useIntegrityCheck ───────────────────────────────────────── */

type IntegrityPhase = "idle" | "running" | "done" | "error";

interface UseIntegrityCheckOptions {
  token: string;
  onUnauthorized: () => void;
}

interface UseIntegrityCheckResult {
  phase: IntegrityPhase;
  result: AuditIntegrityCheckResult | null;
  error: string | null;
  run: () => void;
  dismiss: () => void;
}

export function useIntegrityCheck({
  token,
  onUnauthorized,
}: UseIntegrityCheckOptions): UseIntegrityCheckResult {
  const [phase, setPhase] = useState<IntegrityPhase>("idle");
  const [result, setResult] = useState<AuditIntegrityCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const run = useCallback(async () => {
    if (!isMountedRef.current) return;
    setPhase("running");
    setError(null);
    setResult(null);

    try {
      const res = await runIntegrityCheck(token);
      if (!isMountedRef.current) return;
      setResult(res.data);
      setPhase("done");
    } catch (err) {
      if (!isMountedRef.current) return;
      if (isUnauthorized(err)) { onUnauthorized(); return; }
      setPhase("error");
      setError(parseApiError(err));
    }
  }, [token, onUnauthorized]);

  const dismiss = useCallback(() => {
    setPhase("idle");
    setResult(null);
    setError(null);
  }, []);

  return { phase, result, error, run, dismiss };
}
