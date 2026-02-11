import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { readStoredSession, writeStoredSession, fetchMe } from "@/lib/api-client";
import { ErrorBoundary } from "@/components/error-boundary";
import { ImportContextProvider, ModuleDialog } from "@/components/order-pulse";
import { Toaster } from "@/components/ui";
import { AuthPage } from "@/pages/auth-page";
import { AppShell } from "@/layouts/app-shell";
import { DashboardRoute } from "@/pages/dashboard";
import { QueueRoute } from "@/pages/queue";
import { ScanRoute } from "@/pages/scan";
import { PartsRoute } from "@/pages/parts";
import { CardsRoute } from "@/pages/cards";
import { LoopsRoute } from "@/pages/loops";
import { OrderHistoryRoute } from "@/pages/order-history";
import { ReceivingRoute } from "@/pages/receiving";
import { PODetailRoute } from "@/pages/orders/po-detail";
import type { AuthResponse, AuthSession } from "@/types";

function detectGuestMobileImportLink(): boolean {
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  if (params.get("mobile") !== "1") return false;

  const moduleParam = params.get("import");
  const sessionId = params.get("sid")?.trim();
  const sessionToken = params.get("st")?.trim();

  const isSupportedModule = moduleParam === "scan-upcs" || moduleParam === "ai-identify";
  return Boolean(isSupportedModule && sessionId && sessionToken);
}

function GuestMobileImportApp() {
  return (
    <ImportContextProvider>
      <div className="min-h-screen bg-background px-3 py-4">
        <div className="mx-auto max-w-5xl">
          <ModuleDialog />
          <Toaster />
        </div>
      </div>
    </ImportContextProvider>
  );
}

function App() {
  const [session, setSession] = React.useState<AuthSession | null>(() => {
    if (typeof window === "undefined") return null;
    return readStoredSession();
  });
  const [bootstrapping, setBootstrapping] = React.useState(true);
  const [allowGuestMobileImport] = React.useState(() => detectGuestMobileImportLink());

  const clearSession = React.useCallback(() => {
    setSession(null);
    writeStoredSession(null);
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const stored = readStoredSession();
      if (!stored) {
        if (!cancelled) setBootstrapping(false);
        return;
      }

      try {
        const user = await fetchMe(stored.tokens.accessToken);
        const nextSession = { ...stored, user };
        if (!cancelled) {
          setSession(nextSession);
          writeStoredSession(nextSession);
        }
      } catch {
        if (!cancelled) {
          clearSession();
        }
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const handleAuthSuccess = React.useCallback((authResponse: AuthResponse) => {
    const nextSession = {
      tokens: authResponse.tokens,
      user: authResponse.user,
    };

    setSession(nextSession);
    writeStoredSession(nextSession);
  }, []);

  if (bootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading workspace...</span>
        </div>
      </div>
    );
  }

  if (!session) {
    if (allowGuestMobileImport) {
      return <GuestMobileImportApp />;
    }
    return <AuthPage onAuthSuccess={handleAuthSuccess} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppShell session={session} onSignOut={clearSession} />}>
          <Route index element={<ErrorBoundary><DashboardRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="board" element={<Navigate to="/cards" replace />} />
          <Route path="cards" element={<ErrorBoundary><CardsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="loops" element={<ErrorBoundary><LoopsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="loops/:loopId" element={<ErrorBoundary><LoopsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="parts" element={<ErrorBoundary><PartsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="queue" element={<ErrorBoundary><QueueRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="orders" element={<ErrorBoundary><OrderHistoryRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="orders/po/:id" element={<ErrorBoundary><PODetailRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="receiving" element={<ErrorBoundary><ReceivingRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="scan" element={<ErrorBoundary><ScanRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="scan/:cardId" element={<ErrorBoundary><ScanRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          {/* Legacy redirects */}
          <Route path="notifications" element={<Navigate to="/orders" replace />} />
          <Route path="order-pulse" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
