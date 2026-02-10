import * as React from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Boxes,
  CircleAlert,
  Factory,
  Filter,
  Loader2,
  LogOut,
  Package2,
  QrCode,
  RefreshCw,
  Search,
  Sparkles,
  SquareKanban,
  Truck,
  type LucideIcon,
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@/components/ui";
import { ConflictResolver, ManualLookup, ScanResult, Scanner, SyncStatus } from "@/components/scan";
import { OrderPulseOnboarding } from "@/components/order-pulse";
import { useScanSession } from "@/hooks/use-scan-session";
import { configureScanApi } from "@/lib/scan-api";
import { cn } from "@/lib/utils";

const DEFAULT_RAILWAY_API_BASE = "https://api-gateway-production-83fa.up.railway.app";
const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE_URL = (
  RAW_API_BASE_URL || (import.meta.env.PROD ? DEFAULT_RAILWAY_API_BASE : "")
).replace(/\/+$/, "");
const SESSION_STORAGE_KEY = "arda.web.session.v1";

type LoopType = "procurement" | "production" | "transfer";

const LOOP_ORDER: LoopType[] = ["procurement", "production", "transfer"];

const LOOP_META: Record<LoopType, { label: string; icon: LucideIcon }> = {
  procurement: { label: "Procurement", icon: Truck },
  production: { label: "Production", icon: Factory },
  transfer: { label: "Transfer", icon: Package2 },
};

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string;
  tenantName: string;
  tenantSlug?: string;
  tenantLogo?: string;
}

interface AuthSession {
  tokens: AuthTokens;
  user: SessionUser;
}

interface AuthResponse {
  tokens: AuthTokens;
  user: SessionUser;
}

interface QueueSummary {
  totalAwaitingOrders: number;
  oldestCardAgeHours: number;
  byLoopType: Record<string, number>;
}

interface QueueCard {
  id: string;
  cardNumber: number;
  currentStage: string;
  currentStageEnteredAt: string;
  loopId: string;
  loopType: LoopType;
  partId: string;
  facilityId: string;
  minQuantity: number;
  orderQuantity: number;
  numberOfCards: number;
}

type QueueByLoop = Record<LoopType, QueueCard[]>;

interface PartsResponse {
  data: PartRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface PartRecord {
  id: string;
  partNumber: string;
  name: string;
  type: string;
  uom: string;
  isSellable: boolean;
  isActive: boolean;
  updatedAt: string;
}

interface NotificationRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function buildApiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const { method = "GET", token, body } = options;

  const response = await fetch(buildApiUrl(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as Record<string, unknown>)
    : ({ message: await response.text() } as Record<string, unknown>);

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : `Request failed with status ${response.status}`;

    const code = typeof payload.code === "string" ? payload.code : undefined;
    throw new ApiError(response.status, message, code);
  }

  return payload as T;
}

function parseApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error.";
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function readStoredSession(): AuthSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.tokens?.accessToken || !parsed?.tokens?.refreshToken || !parsed?.user?.id) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredSession(session: AuthSession | null) {
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

async function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return apiRequest<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: input,
  });
}

async function register(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
}): Promise<AuthResponse> {
  return apiRequest<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: input,
  });
}

async function requestPasswordReset(input: { email: string }): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/api/auth/forgot-password", {
    method: "POST",
    body: input,
  });
}

async function resetPasswordWithToken(input: {
  token: string;
  newPassword: string;
}): Promise<{ message: string }> {
  return apiRequest<{ message: string }>("/api/auth/reset-password", {
    method: "POST",
    body: input,
  });
}

async function fetchMe(token: string): Promise<SessionUser> {
  return apiRequest<SessionUser>("/api/auth/me", { token });
}

async function fetchQueueSummary(token: string): Promise<QueueSummary> {
  const response = await apiRequest<{ success: boolean; data: QueueSummary }>(
    "/api/orders/queue/summary",
    { token },
  );

  return response.data;
}

async function fetchQueueByLoop(token: string): Promise<QueueByLoop> {
  const response = await apiRequest<{
    success: boolean;
    data: Partial<Record<LoopType, QueueCard[]>>;
  }>("/api/orders/queue", { token });

  return {
    procurement: response.data.procurement ?? [],
    production: response.data.production ?? [],
    transfer: response.data.transfer ?? [],
  };
}

async function fetchParts(token: string): Promise<PartsResponse> {
  return apiRequest<PartsResponse>("/api/catalog/parts?page=1&pageSize=100", { token });
}

async function fetchNotifications(token: string): Promise<NotificationRecord[]> {
  const response = await apiRequest<{ data: NotificationRecord[] }>("/api/notifications?limit=20", {
    token,
  });
  return response.data;
}

async function fetchUnreadNotificationCount(token: string): Promise<number> {
  const response = await apiRequest<{ count: number }>("/api/notifications/unread-count", {
    token,
  });
  return Number(response.count ?? 0);
}

async function markNotificationRead(token: string, id: string): Promise<void> {
  await apiRequest(`/api/notifications/${id}/read`, {
    method: "PATCH",
    token,
  });
}

async function markAllNotificationsRead(token: string): Promise<void> {
  await apiRequest("/api/notifications/mark-all-read", {
    method: "POST",
    token,
  });
}

function formatRelativeTime(isoTimestamp: string): string {
  const timestamp = new Date(isoTimestamp).getTime();
  const deltaMs = timestamp - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60000);

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (Math.abs(deltaMinutes) < 60) {
    return formatter.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return formatter.format(deltaHours, "hour");
  }

  const deltaDays = Math.round(deltaHours / 24);
  return formatter.format(deltaDays, "day");
}

function formatLoopType(loopType: string): string {
  if (loopType in LOOP_META) {
    return LOOP_META[loopType as LoopType].label;
  }

  return loopType;
}

function queueAgingHours(card: QueueCard): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(card.currentStageEnteredAt).getTime()) / (1000 * 60 * 60)),
  );
}

interface WorkspaceData {
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  queueSummary: QueueSummary | null;
  queueByLoop: QueueByLoop;
  parts: PartRecord[];
  partCount: number;
  notifications: NotificationRecord[];
  unreadNotifications: number;
  refreshAll: () => Promise<void>;
  refreshQueueOnly: () => Promise<void>;
  refreshNotificationsOnly: () => Promise<void>;
  markOneNotificationRead: (id: string) => Promise<void>;
  markEveryNotificationRead: () => Promise<void>;
}

function useWorkspaceData(token: string | null, onUnauthorized: () => void): WorkspaceData {
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [queueSummary, setQueueSummary] = React.useState<QueueSummary | null>(null);
  const [queueByLoop, setQueueByLoop] = React.useState<QueueByLoop>({
    procurement: [],
    production: [],
    transfer: [],
  });
  const [parts, setParts] = React.useState<PartRecord[]>([]);
  const [partCount, setPartCount] = React.useState(0);
  const [notifications, setNotifications] = React.useState<NotificationRecord[]>([]);
  const [unreadNotifications, setUnreadNotifications] = React.useState(0);

  const runRequest = React.useCallback(
    async <T,>(request: () => Promise<T>): Promise<T | null> => {
      try {
        return await request();
      } catch (error) {
        if (isUnauthorized(error)) {
          onUnauthorized();
          return null;
        }

        throw error;
      }
    },
    [onUnauthorized],
  );

  const refreshAll = React.useCallback(async () => {
    if (!token) {
      setQueueSummary(null);
      setQueueByLoop({ procurement: [], production: [], transfer: [] });
      setParts([]);
      setPartCount(0);
      setNotifications([]);
      setUnreadNotifications(0);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsRefreshing(true);

    try {
      const [summaryResult, queueResult, partsResult, notificationsResult, unreadResult] =
        await Promise.all([
          runRequest(() => fetchQueueSummary(token)),
          runRequest(() => fetchQueueByLoop(token)),
          runRequest(() => fetchParts(token)),
          runRequest(() => fetchNotifications(token)),
          runRequest(() => fetchUnreadNotificationCount(token)),
        ]);

      if (
        summaryResult === null ||
        queueResult === null ||
        partsResult === null ||
        notificationsResult === null ||
        unreadResult === null
      ) {
        return;
      }

      setQueueSummary(summaryResult);
      setQueueByLoop(queueResult);
      setParts(partsResult.data ?? []);
      setPartCount(partsResult.pagination.total ?? partsResult.data.length);
      setNotifications(notificationsResult);
      setUnreadNotifications(unreadResult);
      setError(null);
    } catch (error) {
      setError(parseApiError(error));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [runRequest, token]);

  const refreshQueueOnly = React.useCallback(async () => {
    if (!token) return;

    setIsRefreshing(true);
    try {
      const [summaryResult, queueResult] = await Promise.all([
        runRequest(() => fetchQueueSummary(token)),
        runRequest(() => fetchQueueByLoop(token)),
      ]);

      if (summaryResult === null || queueResult === null) {
        return;
      }

      setQueueSummary(summaryResult);
      setQueueByLoop(queueResult);
      setError(null);
    } catch (error) {
      setError(parseApiError(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [runRequest, token]);

  const refreshNotificationsOnly = React.useCallback(async () => {
    if (!token) return;

    setIsRefreshing(true);
    try {
      const [notificationResult, unreadResult] = await Promise.all([
        runRequest(() => fetchNotifications(token)),
        runRequest(() => fetchUnreadNotificationCount(token)),
      ]);

      if (notificationResult === null || unreadResult === null) {
        return;
      }

      setNotifications(notificationResult);
      setUnreadNotifications(unreadResult);
      setError(null);
    } catch (error) {
      setError(parseApiError(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [runRequest, token]);

  const markOneNotificationRead = React.useCallback(
    async (id: string) => {
      if (!token) return;

      try {
        const result = await runRequest(() => markNotificationRead(token, id));
        if (result === null) return;

        await refreshNotificationsOnly();
      } catch (error) {
        setError(parseApiError(error));
      }
    },
    [refreshNotificationsOnly, runRequest, token],
  );

  const markEveryNotificationRead = React.useCallback(async () => {
    if (!token) return;

    try {
      const result = await runRequest(() => markAllNotificationsRead(token));
      if (result === null) return;

      await refreshNotificationsOnly();
    } catch (error) {
      setError(parseApiError(error));
    }
  }, [refreshNotificationsOnly, runRequest, token]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return {
    isLoading,
    isRefreshing,
    error,
    queueSummary,
    queueByLoop,
    parts,
    partCount,
    notifications,
    unreadNotifications,
    refreshAll,
    refreshQueueOnly,
    refreshNotificationsOnly,
    markOneNotificationRead,
    markEveryNotificationRead,
  };
}

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
          <Route index element={<DashboardRoute session={session} onUnauthorized={clearSession} />} />
          <Route
            path="queue"
            element={<QueueRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route
            path="scan"
            element={<ScanRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route
            path="scan/:cardId"
            element={<ScanRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route
            path="parts"
            element={<PartsRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route
            path="notifications"
            element={<NotificationsRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route
            path="order-pulse"
            element={<OrderPulseRoute session={session} onUnauthorized={clearSession} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function AuthPage({ onAuthSuccess }: { onAuthSuccess: (response: AuthResponse) => void }) {
  type AuthMode = "login" | "register" | "forgot" | "reset";

  const [mode, setMode] = React.useState<AuthMode>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/reset-password")) {
      return "reset";
    }
    return "login";
  });
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  const [loginForm, setLoginForm] = React.useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = React.useState({
    firstName: "",
    lastName: "",
    companyName: "",
    email: "",
    password: "",
  });
  const [forgotEmail, setForgotEmail] = React.useState("");
  const [resetToken, setResetToken] = React.useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token")?.trim() ?? "";
  });
  const [resetForm, setResetForm] = React.useState({
    password: "",
    confirmPassword: "",
  });

  const switchMode = React.useCallback((nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setStatusMessage(null);

    if (
      typeof window !== "undefined" &&
      nextMode !== "reset" &&
      window.location.pathname.startsWith("/reset-password")
    ) {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const submitLogin = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setIsSubmitting(true);
      setError(null);
      setStatusMessage(null);

      try {
        const response = await login(loginForm);
        onAuthSuccess(response);
      } catch (error) {
        setError(parseApiError(error));
      } finally {
        setIsSubmitting(false);
      }
    },
    [loginForm, onAuthSuccess],
  );

  const submitRegistration = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setIsSubmitting(true);
      setError(null);
      setStatusMessage(null);

      try {
        const response = await register(registerForm);
        onAuthSuccess(response);
      } catch (error) {
        setError(parseApiError(error));
      } finally {
        setIsSubmitting(false);
      }
    },
    [onAuthSuccess, registerForm],
  );

  const submitForgotPassword = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setStatusMessage(null);

    try {
      const response = await requestPasswordReset({ email: forgotEmail });
      setStatusMessage(
        response.message || "If an account exists for that email, a reset link has been sent.",
      );
    } catch (error) {
      setError(parseApiError(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [forgotEmail]);

  const submitResetPassword = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setStatusMessage(null);

      const token = resetToken.trim();
      if (!token) {
        setError("Reset token is missing. Please use the link from your email.");
        return;
      }

      if (resetForm.password.length < 8) {
        setError("Password must be at least 8 characters.");
        return;
      }

      if (resetForm.password !== resetForm.confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      setIsSubmitting(true);
      try {
        const response = await resetPasswordWithToken({
          token,
          newPassword: resetForm.password,
        });

        setStatusMessage(response.message || "Password reset successful. You can now sign in.");
        setResetForm({ password: "", confirmPassword: "" });
        setMode("login");

        if (typeof window !== "undefined" && window.location.pathname.startsWith("/reset-password")) {
          window.history.replaceState({}, "", "/");
        }
      } catch (error) {
        setError(parseApiError(error));
      } finally {
        setIsSubmitting(false);
      }
    },
    [resetForm.confirmPassword, resetForm.password, resetToken],
  );

  const cardTitle =
    mode === "reset" ? "Reset your password" : mode === "forgot" ? "Recover your account" : "Welcome to Arda";

  const cardDescription =
    mode === "reset"
      ? "Set a new password to regain access to your workspace."
      : mode === "forgot"
        ? "Enter your email and we will send a secure password reset link."
        : "Use your workspace credentials to manage queue flow and card scanning.";

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[1fr_520px]">
      <section className="relative hidden overflow-hidden md:block">
        <div className="absolute inset-0 auth-panel-gradient" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.32),transparent_45%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(10,104,243,0.22),transparent_50%)]" />

        <div className="relative z-10 flex h-full flex-col justify-between px-14 py-16 text-white">
          <div className="space-y-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/80">Arda</p>
            <div className="space-y-3">
              <h1 className="max-w-md text-4xl font-bold leading-tight">
                Kanban operations with live queue decisions.
              </h1>
              <p className="max-w-lg text-sm leading-relaxed text-white/85">
                Track triggered cards, run scan workflows, and dispatch procurement or production orders from one workspace.
              </p>
            </div>
          </div>

          <div className="grid gap-3 text-sm">
            <div className="rounded-xl border border-white/20 bg-white/12 p-4 backdrop-blur-sm">
              <p className="font-semibold">Queue clarity</p>
              <p className="mt-1 text-white/85">Prioritize old triggered cards before they become stockout risk.</p>
            </div>
            <div className="rounded-xl border border-white/20 bg-white/12 p-4 backdrop-blur-sm">
              <p className="font-semibold">Reliable scanning</p>
              <p className="mt-1 text-white/85">Offline queueing and sync protection keep floor workflows moving.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-10 md:px-14">
        <Card className="w-full max-w-md border-border/90 shadow-arda-lg">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-2xl font-bold tracking-tight">{cardTitle}</CardTitle>
            <CardDescription>{cardDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {mode !== "reset" && (
              <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg bg-muted p-1">
                <button
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    mode === "login" || mode === "forgot"
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground",
                  )}
                  onClick={() => switchMode("login")}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    mode === "register"
                      ? "bg-background text-foreground shadow"
                      : "text-muted-foreground",
                  )}
                  onClick={() => switchMode("register")}
                >
                  Create Account
                </button>
              </div>
            )}

            {mode === "login" && (
              <form className="space-y-4" onSubmit={submitLogin}>
                <label className="form-label-arda">
                  Email
                  <Input
                    required
                    type="email"
                    value={loginForm.email}
                    onChange={(event) =>
                      setLoginForm((previous) => ({ ...previous, email: event.target.value }))
                    }
                    placeholder="you@company.com"
                  />
                </label>

                <label className="form-label-arda">
                  Password
                  <Input
                    required
                    type="password"
                    value={loginForm.password}
                    onChange={(event) =>
                      setLoginForm((previous) => ({ ...previous, password: event.target.value }))
                    }
                    placeholder="••••••••"
                  />
                </label>

                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs font-medium text-primary hover:underline"
                    onClick={() => switchMode("forgot")}
                  >
                    Forgot password?
                  </button>
                </div>

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Signing in...
                    </span>
                  ) : (
                    "Sign In"
                  )}
                </Button>
              </form>
            )}

            {mode === "register" && (
              <form className="space-y-4" onSubmit={submitRegistration}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="form-label-arda">
                    First name
                    <Input
                      required
                      value={registerForm.firstName}
                      onChange={(event) =>
                        setRegisterForm((previous) => ({ ...previous, firstName: event.target.value }))
                      }
                    />
                  </label>
                  <label className="form-label-arda">
                    Last name
                    <Input
                      required
                      value={registerForm.lastName}
                      onChange={(event) =>
                        setRegisterForm((previous) => ({ ...previous, lastName: event.target.value }))
                      }
                    />
                  </label>
                </div>

                <label className="form-label-arda">
                  Company
                  <Input
                    required
                    value={registerForm.companyName}
                    onChange={(event) =>
                      setRegisterForm((previous) => ({ ...previous, companyName: event.target.value }))
                    }
                    placeholder="Acme Manufacturing"
                  />
                </label>

                <label className="form-label-arda">
                  Email
                  <Input
                    required
                    type="email"
                    value={registerForm.email}
                    onChange={(event) =>
                      setRegisterForm((previous) => ({ ...previous, email: event.target.value }))
                    }
                    placeholder="you@company.com"
                  />
                </label>

                <label className="form-label-arda">
                  Password
                  <Input
                    required
                    type="password"
                    minLength={8}
                    value={registerForm.password}
                    onChange={(event) =>
                      setRegisterForm((previous) => ({ ...previous, password: event.target.value }))
                    }
                    placeholder="At least 8 characters"
                  />
                </label>

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating workspace...
                    </span>
                  ) : (
                    "Create Account"
                  )}
                </Button>
              </form>
            )}

            {mode === "forgot" && (
              <form className="space-y-4" onSubmit={submitForgotPassword}>
                <label className="form-label-arda">
                  Email
                  <Input
                    required
                    type="email"
                    value={forgotEmail}
                    onChange={(event) => setForgotEmail(event.target.value)}
                    placeholder="you@company.com"
                  />
                </label>

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending reset link...
                    </span>
                  ) : (
                    "Send Reset Link"
                  )}
                </Button>

                <Button type="button" variant="link" className="w-full" onClick={() => switchMode("login")}>
                  Back to sign in
                </Button>
              </form>
            )}

            {mode === "reset" && (
              <form className="space-y-4" onSubmit={submitResetPassword}>
                {!resetToken && (
                  <label className="form-label-arda">
                    Reset token
                    <Input
                      required
                      value={resetToken}
                      onChange={(event) => setResetToken(event.target.value)}
                      placeholder="Paste reset token"
                    />
                  </label>
                )}

                <label className="form-label-arda">
                  New password
                  <Input
                    required
                    type="password"
                    minLength={8}
                    value={resetForm.password}
                    onChange={(event) =>
                      setResetForm((previous) => ({ ...previous, password: event.target.value }))
                    }
                    placeholder="At least 8 characters"
                  />
                </label>

                <label className="form-label-arda">
                  Confirm new password
                  <Input
                    required
                    type="password"
                    minLength={8}
                    value={resetForm.confirmPassword}
                    onChange={(event) =>
                      setResetForm((previous) => ({ ...previous, confirmPassword: event.target.value }))
                    }
                    placeholder="Re-enter password"
                  />
                </label>

                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Resetting password...
                    </span>
                  ) : (
                    "Reset Password"
                  )}
                </Button>

                <Button type="button" variant="link" className="w-full" onClick={() => switchMode("login")}>
                  Back to sign in
                </Button>
              </form>
            )}

            {statusMessage && (
              <div className="mt-4 rounded-md border border-[hsl(var(--arda-success)/0.25)] bg-[hsl(var(--arda-success)/0.08)] px-3 py-2 text-sm text-[hsl(var(--arda-success))]">
                {statusMessage}
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-md border border-[hsl(var(--arda-error)/0.25)] bg-[hsl(var(--arda-error)/0.08)] px-3 py-2 text-sm text-[hsl(var(--arda-error))]">
                {error}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

interface AppShellProps {
  session: AuthSession;
  onSignOut: () => void;
}

function AppShell({ session, onSignOut }: AppShellProps) {
  const location = useLocation();

  const navItems = React.useMemo(
    () => [
      { to: "/", label: "Dashboard", icon: Activity },
      { to: "/queue", label: "Queue", icon: SquareKanban },
      { to: "/scan", label: "Scan", icon: QrCode },
      { to: "/parts", label: "Parts", icon: Boxes },
      { to: "/notifications", label: "Notifications", icon: Bell },
      { to: "/order-pulse", label: "Order Pulse", icon: Sparkles },
    ],
    [],
  );

  const sectionTitle = React.useMemo(() => {
    if (location.pathname.startsWith("/queue")) return "Order Queue";
    if (location.pathname.startsWith("/scan")) return "Scan Workspace";
    if (location.pathname.startsWith("/parts")) return "Parts Catalog";
    if (location.pathname.startsWith("/notifications")) return "Notifications";
    if (location.pathname.startsWith("/order-pulse")) return "Order Pulse";
    return "Operations Dashboard";
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[250px_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="border-b border-sidebar-border px-5 py-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sidebar-muted">Arda</p>
          <h1 className="mt-2 text-lg font-semibold text-sidebar-foreground">Control Center</h1>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => {
            const ItemIcon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => cn("sidebar-nav-item", isActive && "active")}
              >
                <ItemIcon className="h-4 w-4" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border px-4 py-4 text-xs text-sidebar-muted">
          <p className="font-semibold text-sidebar-foreground">
            {session.user.firstName} {session.user.lastName}
          </p>
          <p className="mt-1">{session.user.tenantName}</p>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="border-b bg-card/80 px-4 py-3 backdrop-blur-md md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{sectionTitle}</h2>
              <p className="text-sm text-muted-foreground">{session.user.tenantName}</p>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative hidden md:block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="w-64 pl-9" placeholder="Search cards, parts, loops" />
              </div>
              <Button variant="outline" onClick={onSignOut}>
                <LogOut className="h-4 w-4" />
                Sign out
              </Button>
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden">
            {navItems.map((item) => {
              const ItemIcon = item.icon;
              const active =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);

              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium whitespace-nowrap",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground",
                  )}
                >
                  <ItemIcon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function DashboardRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const {
    isLoading,
    isRefreshing,
    error,
    queueSummary,
    queueByLoop,
    parts,
    partCount,
    notifications,
    unreadNotifications,
    refreshAll,
  } = useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  if (isLoading) {
    return <LoadingState message="Loading dashboard metrics..." />;
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border bg-[linear-gradient(120deg,hsl(var(--arda-orange))_0%,hsl(var(--arda-orange-hover))_50%,hsl(var(--arda-blue))_120%)] p-6 text-white shadow-arda-orange">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.24),transparent_45%)]" />
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold">Live queue command view</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/90">
              Track triggered cards by loop type, prioritize aging work, and keep scan operations in sync with Railway services.
            </p>
          </div>
          <Button asChild variant="secondary">
            <Link to="/queue">
              Open Queue Board
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={refreshAll} />}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Triggered cards"
          value={String(queueSummary?.totalAwaitingOrders ?? 0)}
          detail="Awaiting order creation"
          icon={SquareKanban}
        />
        <MetricCard
          label="Oldest queue age"
          value={`${queueSummary?.oldestCardAgeHours ?? 0}h`}
          detail="Oldest triggered card"
          icon={CircleAlert}
          tone={(queueSummary?.oldestCardAgeHours ?? 0) >= 24 ? "warning" : "default"}
        />
        <MetricCard
          label="Active parts"
          value={String(partCount || parts.length)}
          detail="Catalog records available"
          icon={Boxes}
        />
        <MetricCard
          label="Unread alerts"
          value={String(unreadNotifications)}
          detail="From notifications service"
          icon={Bell}
          tone={unreadNotifications > 0 ? "accent" : "default"}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {LOOP_ORDER.map((loopType) => {
          const loopCards = queueByLoop[loopType] ?? [];
          const Icon = LOOP_META[loopType].icon;

          return (
            <Card key={loopType} className="card-arda">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-4 w-4 text-accent" />
                    {LOOP_META[loopType].label}
                  </CardTitle>
                  <Badge variant="accent">{loopCards.length}</Badge>
                </div>
                <CardDescription>Recent cards from this loop</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {loopCards.length === 0 && (
                  <p className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    No triggered cards.
                  </p>
                )}

                {loopCards.slice(0, 3).map((card) => {
                  const ageHours = queueAgingHours(card);
                  return (
                    <div key={card.id} className="card-order-item">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold">
                            <span className="link-arda">Card #{card.cardNumber}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">Part {card.partId.slice(0, 8)}...</p>
                        </div>
                        <Badge variant={ageHours >= 24 ? "warning" : "secondary"}>{ageHours}h</Badge>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Recent notifications</CardTitle>
            <Button asChild variant="link" size="sm">
              <Link to="/notifications">View all</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {notifications.length === 0 && (
            <p className="text-sm text-muted-foreground">No notifications yet.</p>
          )}

          {notifications.slice(0, 5).map((notification) => (
            <div
              key={notification.id}
              className={cn(
                "rounded-lg border px-3 py-3",
                notification.isRead
                  ? "border-border bg-card"
                  : "border-[hsl(var(--arda-blue)/0.35)] bg-[hsl(var(--arda-blue)/0.06)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{notification.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{notification.body}</p>
                </div>
                {!notification.isRead && <Badge variant="accent">New</Badge>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{formatRelativeTime(notification.createdAt)}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {isRefreshing && (
        <div className="fixed bottom-4 right-4 rounded-full bg-card px-3 py-2 shadow-arda-md">
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Refreshing live data...
          </span>
        </div>
      )}
    </div>
  );
}

function QueueRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { isLoading, isRefreshing, error, queueSummary, queueByLoop, refreshQueueOnly } =
    useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  const [activeLoopFilter, setActiveLoopFilter] = React.useState<LoopType | "all">("all");
  const [searchTerm, setSearchTerm] = React.useState("");

  const loopsToRender = activeLoopFilter === "all" ? LOOP_ORDER : [activeLoopFilter];

  const filteredQueue = React.useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    const matchesSearch = (card: QueueCard) => {
      if (!normalizedSearch) return true;

      return (
        card.id.toLowerCase().includes(normalizedSearch) ||
        card.partId.toLowerCase().includes(normalizedSearch) ||
        card.loopId.toLowerCase().includes(normalizedSearch)
      );
    };

    return {
      procurement: queueByLoop.procurement.filter(matchesSearch),
      production: queueByLoop.production.filter(matchesSearch),
      transfer: queueByLoop.transfer.filter(matchesSearch),
    } satisfies QueueByLoop;
  }, [queueByLoop, searchTerm]);

  if (isLoading) {
    return <LoadingState message="Loading queue board..." />;
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} onRetry={refreshQueueOnly} />}

      <Card className="border-[hsl(var(--arda-blue)/0.22)] bg-[hsl(var(--arda-blue)/0.06)]">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="bg-background pl-9"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Find by card, part, or loop"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setActiveLoopFilter("all")}
              className={cn(activeLoopFilter === "all" && "border-primary text-primary")}
            >
              <Filter className="h-4 w-4" />
              All loops
            </Button>
            {LOOP_ORDER.map((loopType) => (
              <Button
                key={loopType}
                variant="outline"
                size="sm"
                onClick={() => setActiveLoopFilter(loopType)}
                className={cn(
                  activeLoopFilter === loopType && "border-primary text-primary",
                )}
              >
                {LOOP_META[loopType].label}
              </Button>
            ))}
            <Button variant="accent" size="sm" onClick={() => void refreshQueueOnly()}>
              {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {loopsToRender.map((loopType) => {
          const cards = filteredQueue[loopType];
          const Icon = LOOP_META[loopType].icon;

          return (
            <section
              key={loopType}
              className="rounded-2xl border border-[hsl(var(--arda-blue)/0.25)] bg-[hsl(var(--arda-blue)/0.07)] p-3"
            >
              <header className="mb-3 rounded-xl bg-card px-3 py-3 shadow-xs">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-accent" />
                    {LOOP_META[loopType].label}
                  </h3>
                  <Badge variant="accent">{cards.length}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {queueSummary?.byLoopType[loopType] ?? cards.length} cards awaiting action
                </p>
              </header>

              <div className="space-y-2">
                {cards.length === 0 && (
                  <div className="rounded-xl border border-dashed border-border bg-card px-3 py-8 text-center text-sm text-muted-foreground">
                    No cards for this filter.
                  </div>
                )}

                {cards.map((card) => {
                  const ageHours = queueAgingHours(card);
                  const highRisk = ageHours >= 24;

                  return (
                    <article key={card.id} className="card-order-item">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">
                            <span className="link-arda">Card #{card.cardNumber}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">Part {card.partId.slice(0, 8)}...</p>
                        </div>
                        <Badge variant={highRisk ? "warning" : "secondary"}>{ageHours}h</Badge>
                      </div>

                      <div className="mt-2 space-y-1">
                        <div className="name-value-pair">
                          <span className="name-value-pair-label">Order Qty:</span>
                          <span className="name-value-pair-value">{card.orderQuantity}</span>
                        </div>
                        <div className="name-value-pair">
                          <span className="name-value-pair-label">Minimum:</span>
                          <span className="name-value-pair-value">{card.minQuantity}</span>
                        </div>
                        <div className="name-value-pair">
                          <span className="name-value-pair-label">Updated:</span>
                          <span className="name-value-pair-value">{formatRelativeTime(card.currentStageEnteredAt)}</span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ScanRoute({
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

function PartsRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const { isLoading, isRefreshing, error, parts, partCount, refreshAll } = useWorkspaceData(
    session.tokens.accessToken,
    onUnauthorized,
  );
  const [search, setSearch] = React.useState("");

  const filteredParts = React.useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return parts;

    return parts.filter(
      (part) =>
        part.partNumber.toLowerCase().includes(normalized) ||
        part.name.toLowerCase().includes(normalized) ||
        part.type.toLowerCase().includes(normalized),
    );
  }, [parts, search]);

  if (isLoading) {
    return <LoadingState message="Loading parts catalog..." />;
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={refreshAll} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Catalog parts</CardTitle>
              <CardDescription>{partCount} total records from catalog service</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-72 max-w-full">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search part number or name"
                />
              </div>
              <Button variant="outline" onClick={() => void refreshAll()}>
                {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <table className="min-w-full divide-y divide-table-border text-sm">
              <thead className="bg-table-header">
                <tr>
                  <th className="table-cell-density text-left font-semibold">Part #</th>
                  <th className="table-cell-density text-left font-semibold">Name</th>
                  <th className="table-cell-density text-left font-semibold">Type</th>
                  <th className="table-cell-density text-left font-semibold">UOM</th>
                  <th className="table-cell-density text-left font-semibold">Status</th>
                  <th className="table-cell-density text-left font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filteredParts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No parts match your search.
                    </td>
                  </tr>
                )}

                {filteredParts.map((part) => (
                  <tr key={part.id} className="border-t hover:bg-table-row-hover">
                    <td className="table-cell-density">
                      <span className="link-arda">{part.partNumber}</span>
                    </td>
                    <td className="table-cell-density font-medium">{part.name}</td>
                    <td className="table-cell-density">
                      <Badge variant="secondary">{part.type.replaceAll("_", " ")}</Badge>
                    </td>
                    <td className="table-cell-density uppercase">{part.uom}</td>
                    <td className="table-cell-density">
                      {part.isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="warning">Inactive</Badge>
                      )}
                    </td>
                    <td className="table-cell-density text-muted-foreground">
                      {formatRelativeTime(part.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function NotificationsRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const {
    isLoading,
    isRefreshing,
    error,
    notifications,
    unreadNotifications,
    refreshNotificationsOnly,
    markOneNotificationRead,
    markEveryNotificationRead,
  } = useWorkspaceData(session.tokens.accessToken, onUnauthorized);

  if (isLoading) {
    return <LoadingState message="Loading notifications..." />;
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onRetry={refreshNotificationsOnly} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Notification feed</CardTitle>
              <CardDescription>{unreadNotifications} unread notifications</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void refreshNotificationsOnly()}>
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </Button>
              <Button variant="secondary" onClick={() => void markEveryNotificationRead()}>
                Mark all read
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-2">
          {notifications.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              No notifications found.
            </p>
          )}

          {notifications.map((notification) => (
            <article
              key={notification.id}
              className={cn(
                "rounded-xl border p-3",
                notification.isRead
                  ? "border-border bg-card"
                  : "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.07)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{notification.title}</p>
                  <p className="text-sm text-muted-foreground">{notification.body}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!notification.isRead && <Badge variant="accent">Unread</Badge>}
                  {!notification.isRead && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void markOneNotificationRead(notification.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>{formatLoopType(notification.type)}</span>
                <span>{formatRelativeTime(notification.createdAt)}</span>
              </div>
            </article>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: "default" | "warning" | "accent";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-bold">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
          <div
            className={cn(
              "rounded-full p-2",
              tone === "warning" && "bg-[hsl(var(--arda-warning)/0.12)] text-[hsl(var(--arda-warning))]",
              tone === "accent" && "bg-[hsl(var(--arda-blue)/0.12)] text-[hsl(var(--arda-blue))]",
              tone === "default" && "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--arda-error)/0.28)] bg-[hsl(var(--arda-error)/0.1)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--arda-error))]">
          <CircleAlert className="h-4 w-4" />
          {message}
        </p>
        <Button variant="outline" size="sm" onClick={() => void onRetry()}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function OrderPulseRoute({
  session,
  onUnauthorized,
}: {
  session: AuthSession;
  onUnauthorized: () => void;
}) {
  const [isComplete, setIsComplete] = React.useState(false);
  const [syncedCount, setSyncedCount] = React.useState(0);

  const handleComplete = React.useCallback(
    (products: { id: string; name: string }[]) => {
      setSyncedCount(products.length);
      setIsComplete(true);
    },
    [],
  );

  const handleCancel = React.useCallback(() => {
    window.history.pushState({}, "", "/");
    window.location.reload();
  }, []);

  if (isComplete) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-md text-center">
          <CardContent className="p-8 space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[hsl(var(--arda-success)/0.12)]">
              <Sparkles className="h-8 w-8 text-[hsl(var(--arda-success))]" />
            </div>
            <h3 className="text-xl font-bold">Products Synced Successfully!</h3>
            <p className="text-sm text-muted-foreground">
              {syncedCount} products have been imported and synced to {session.user.tenantName}.
              They'll appear in your Parts Catalog shortly.
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <Button asChild>
                <Link to="/parts">View Parts Catalog</Link>
              </Button>
              <Button variant="outline" onClick={() => setIsComplete(false)}>
                Import More Products
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <OrderPulseOnboarding
      tenantName={session.user.tenantName}
      onComplete={handleComplete}
      onCancel={handleCancel}
    />
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center rounded-xl border border-dashed border-border bg-card">
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {message}
      </span>
    </div>
  );
}

export default App;
