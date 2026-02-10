import * as React from "react";
import { useParams } from "react-router-dom";
import { Loader2, QrCode } from "lucide-react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ConflictResolver, ManualLookup, ScanResult, Scanner, SyncStatus } from "@/components/scan";
import { useScanSession } from "@/hooks/use-scan-session";
import { buildApiUrl } from "@/lib/api-client";
import { configureScanApi } from "@/lib/scan-api";
import { formatRelativeTime } from "@/lib/formatters";
import type { AuthSession } from "@/types";

export function ScanRoute({
  session,
  onUnauthorized: _onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { cardId } = useParams();
  const [showQueueDetails, setShowQueueDetails] = React.useState(false);
  const autoTriggeredCardRef = React.useRef<string | null>(null);
  const deepLinkCardId = cardId?.trim() ?? "";
  const deepLinkIsValid =
    !deepLinkCardId
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deepLinkCardId);

  const { result, conflicts, isProcessing, queue, processScan, dismissResult, resolveConflict } =
    useScanSession();

  React.useEffect(() => {
    configureScanApi({
      baseUrl: buildApiUrl("/api/kanban"),
      getToken: () => session.tokens.accessToken,
      timeout: 10_000,
    });
  }, [session.tokens.accessToken]);

  React.useEffect(() => {
    if (!deepLinkCardId || !deepLinkIsValid) return;
    if (autoTriggeredCardRef.current === deepLinkCardId) return;

    autoTriggeredCardRef.current = deepLinkCardId;
    void processScan(deepLinkCardId);
  }, [deepLinkCardId, deepLinkIsValid, processScan]);

  const retryCardId = result?.cardId;

  return (
    <div className="space-y-4">
      {deepLinkCardId && (
        <Card className="border-[hsl(var(--arda-blue)/0.25)] bg-[hsl(var(--arda-blue)/0.07)]">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Deep-Link Scan</CardTitle>
            <CardDescription>
              {deepLinkIsValid
                ? `Card ${deepLinkCardId} detected from QR deep-link.`
                : `Card ID "${deepLinkCardId}" is not a valid UUID.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                if (!deepLinkIsValid) return;
                void processScan(deepLinkCardId);
              }}
              disabled={isProcessing || !deepLinkIsValid}
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              Trigger Deep-Link Card
            </Button>
          </CardContent>
        </Card>
      )}

      <SyncStatus
        counts={queue.status}
        isOnline={queue.isOnline}
        isReplaying={queue.isReplaying}
        onSync={() => void queue.replay()}
        onClearSynced={() => void queue.clearSynced()}
        onViewDetails={() => setShowQueueDetails((prev) => !prev)}
      />

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Scan Card</CardTitle>
            <CardDescription>
              Use camera scan when supported, or paste a UUID for manual lookup.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Scanner
              onScan={(nextCardId) => {
                void processScan(nextCardId);
              }}
              isProcessing={isProcessing}
            />
            <ManualLookup
              onSubmit={(nextCardId) => {
                void processScan(nextCardId);
              }}
              isProcessing={isProcessing}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Scan status</CardTitle>
            <CardDescription>
              Latest result, replay conflicts, and queue continuity status.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {result ? (
              <ScanResult
                result={result}
                onDismiss={dismissResult}
                onRetry={retryCardId ? () => void processScan(retryCardId) : undefined}
              />
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                Submit a scan to see response details here.
              </p>
            )}

            {conflicts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Replay conflicts
                </p>
                {conflicts.map((conflict) => (
                  <ConflictResolver
                    key={conflict.queueItemId}
                    conflict={conflict}
                    onResolve={(queueItemId, action) => {
                      void resolveConflict(queueItemId, action);
                    }}
                    isProcessing={isProcessing}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {showQueueDetails && queue.events.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Offline Queue Details</CardTitle>
            <CardDescription>
              Persisted scans survive reload and replay automatically when connectivity returns.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {queue.events
              .slice()
              .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
              .map((event) => (
                <div key={event.id} className="rounded-md border px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-foreground">{event.cardId.slice(0, 18)}...</span>
                    <Badge variant={event.status === "failed" ? "destructive" : "secondary"}>
                      {event.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Captured {formatRelativeTime(event.scannedAt)}
                    {event.retryCount > 0 ? ` • retries ${event.retryCount}` : ""}
                  </p>
                  {event.lastError && (
                    <p className="mt-1 text-[hsl(var(--arda-error))]">{event.lastError}</p>
                  )}
                </div>
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
