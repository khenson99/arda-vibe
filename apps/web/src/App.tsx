import * as React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { readStoredSession, writeStoredSession, fetchMe } from "@/lib/api-client";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthPage } from "@/pages/auth-page";
import { AppShell } from "@/layouts/app-shell";
import { DashboardRoute } from "@/pages/dashboard";
import { QueueRoute } from "@/pages/queue";
import { ScanRoute } from "@/pages/scan";
import { PartsRoute } from "@/pages/parts";
import { NotificationsRoute } from "@/pages/notifications";
import type { AuthResponse, AuthSession } from "@/types";

function App() {
  const [session, setSession] = React.useState<AuthSession | null>(() => {
    if (typeof window === "undefined") return null;
    return readStoredSession();
  });
  const [bootstrapping, setBootstrapping] = React.useState(true);

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
    return <AuthPage onAuthSuccess={handleAuthSuccess} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppShell session={session} onSignOut={clearSession} />}>
          <Route index element={<ErrorBoundary><DashboardRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="queue" element={<ErrorBoundary><QueueRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="scan" element={<ErrorBoundary><ScanRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="scan/:cardId" element={<ErrorBoundary><ScanRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="parts" element={<ErrorBoundary><PartsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="notifications" element={<ErrorBoundary><NotificationsRoute session={session} onUnauthorized={clearSession} /></ErrorBoundary>} />
          <Route path="order-pulse" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
