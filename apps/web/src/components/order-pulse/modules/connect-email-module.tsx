import * as React from "react";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Globe,
  Loader2,
  Mail,
  MailCheck,
  Package,
  ShieldCheck,
} from "lucide-react";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  initGoogleEmailLink,
  parseApiError,
  readStoredSession,
} from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/constants";
import { PRESET_VENDORS, type EmailProvider } from "../types";
import { useImportContext } from "../import-context";

const PROVIDERS: { id: EmailProvider; label: string; icon: string }[] = [
  { id: "gmail", label: "Gmail / Google Workspace", icon: "📧" },
  { id: "outlook", label: "Outlook / Microsoft 365", icon: "📬" },
  { id: "yahoo", label: "Yahoo Mail", icon: "✉️" },
  { id: "other", label: "Other (IMAP)", icon: "🔗" },
];

const CONNECT_PHASES = [
  "Secure OAuth handshake",
  "Mailbox permissions verified",
  "Preparing your first inbox scan",
];

export interface ConnectEmailModuleProps {
  onConnected?: () => void;
  onContinue?: () => void;
}

export function ConnectEmailModule({ onConnected, onContinue }: ConnectEmailModuleProps = {}) {
  const { state, dispatch } = useImportContext();
  const connection = state.emailConnection;

  const [email, setEmail] = React.useState("");
  const [provider, setProvider] = React.useState<EmailProvider>("gmail");
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [connectPhaseIndex, setConnectPhaseIndex] = React.useState(0);
  const [oauthError, setOauthError] = React.useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = React.useState<string | null>(null);

  const defaultVendorIds = React.useMemo(
    () =>
      PRESET_VENDORS.filter((vendor) => vendor.hasApi)
        .slice(0, 3)
        .map((vendor) => vendor.id),
    [],
  );

  const oauthEventSourceOrigin = React.useMemo(() => {
    if (typeof window === "undefined") return "";
    try {
      return API_BASE_URL ? new URL(API_BASE_URL).origin : window.location.origin;
    } catch {
      return window.location.origin;
    }
  }, []);

  const applyConnectedState = React.useCallback(
    (linkedEmail: string) => {
      dispatch({
        type: "SET_EMAIL_CONNECTION",
        connection: {
          provider: "gmail",
          email: linkedEmail,
          connectedAt: new Date().toISOString(),
          status: "connected",
        },
      });

      if (state.selectedVendors.size === 0) {
        dispatch({ type: "SET_VENDORS", vendorIds: defaultVendorIds });
      }

      setIsConnecting(false);
      setOauthError(null);
      setOauthStatus(`Gmail linked as ${linkedEmail}`);
      onConnected?.();
    },
    [defaultVendorIds, dispatch, onConnected, state.selectedVendors.size],
  );

  const waitForGooglePopupResult = React.useCallback(
    (authorizationUrl: string) =>
      new Promise<{ status: "success" | "error"; email?: string; error?: string }>(
        (resolve, reject) => {
          let callbackOrigin = oauthEventSourceOrigin;
          try {
            const authUrl = new URL(authorizationUrl);
            const redirectUri = authUrl.searchParams.get("redirect_uri");
            if (redirectUri) {
              callbackOrigin = new URL(redirectUri).origin;
            }
          } catch {
            callbackOrigin = oauthEventSourceOrigin;
          }

          const allowedOrigins = new Set(
            [oauthEventSourceOrigin, callbackOrigin, window.location.origin].filter(Boolean),
          );

          const popup = window.open(
            authorizationUrl,
            "arda-google-oauth",
            "width=520,height=680,resizable,scrollbars",
          );

          if (!popup) {
            window.location.assign(authorizationUrl);
            reject(new Error("Popup blocked. Redirecting to Google..."));
            return;
          }

          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error("Google OAuth timed out. Please try again."));
          }, 2 * 60 * 1000);

          const closeWatcher = window.setInterval(() => {
            if (popup.closed) {
              cleanup();
              reject(new Error("Google OAuth window was closed before completion."));
            }
          }, 500);

          const onMessage = (event: MessageEvent) => {
            if (!allowedOrigins.has(event.origin)) return;
            const payload = event.data as
              | { type?: string; status?: "success" | "error"; email?: string; error?: string }
              | undefined;
            if (!payload || payload.type !== "arda:google-oauth-link") return;

            cleanup();
            resolve({
              status: payload.status || "error",
              email: payload.email,
              error: payload.error,
            });
          };

          const cleanup = () => {
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timeout);
            window.clearInterval(closeWatcher);
          };

          window.addEventListener("message", onMessage);
        },
      ),
    [oauthEventSourceOrigin],
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const oauthResult = url.searchParams.get("gmail_oauth");
    if (!oauthResult) return;

    const gmailEmail = url.searchParams.get("gmail_email") || readStoredSession()?.user.email || "";
    const gmailError = url.searchParams.get("gmail_error") || "Gmail OAuth failed.";

    if (oauthResult === "success" && gmailEmail) {
      applyConnectedState(gmailEmail);
    } else {
      setIsConnecting(false);
      setOauthStatus(null);
      setOauthError(gmailError);
      dispatch({
        type: "SET_EMAIL_CONNECTION",
        connection: {
          provider: "gmail",
          email: gmailEmail || readStoredSession()?.user.email || "",
          connectedAt: new Date().toISOString(),
          status: "error",
        },
      });
    }

    url.searchParams.delete("gmail_oauth");
    url.searchParams.delete("gmail_email");
    url.searchParams.delete("gmail_error");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [applyConnectedState, dispatch]);

  const handleConnect = async () => {
    const typedEmail = email.trim();
    const session = readStoredSession();
    const fallbackSessionEmail = session?.user?.email?.trim() || "";
    const targetEmail = typedEmail || fallbackSessionEmail;

    if (isConnecting) return;
    if (provider !== "gmail" && !targetEmail) return;

    setIsConnecting(true);
    setConnectPhaseIndex(0);
    setOauthError(null);
    setOauthStatus(null);

    dispatch({
      type: "SET_EMAIL_CONNECTION",
      connection: {
        provider,
        email: targetEmail,
        connectedAt: new Date().toISOString(),
        status: "syncing",
      },
    });

    if (provider === "gmail") {
      if (!session?.tokens?.accessToken) {
        setIsConnecting(false);
        setOauthError("Session expired. Sign in again, then reconnect Gmail.");
        dispatch({
          type: "SET_EMAIL_CONNECTION",
          connection: {
            provider: "gmail",
            email: targetEmail,
            connectedAt: new Date().toISOString(),
            status: "error",
          },
        });
        return;
      }

      try {
        const { authorizationUrl } = await initGoogleEmailLink(session.tokens.accessToken, {
          origin: window.location.origin,
        });
        const popupResult = await waitForGooglePopupResult(authorizationUrl);

        if (popupResult.status !== "success") {
          throw new Error(popupResult.error || "Google OAuth was not completed.");
        }

        applyConnectedState(popupResult.email || targetEmail || fallbackSessionEmail);
      } catch (error) {
        if (error instanceof Error && error.message.includes("Popup blocked. Redirecting")) {
          return;
        }

        const message = parseApiError(error);
        setIsConnecting(false);
        setOauthStatus(null);
        setOauthError(message);
        dispatch({
          type: "SET_EMAIL_CONNECTION",
          connection: {
            provider: "gmail",
            email: targetEmail,
            connectedAt: new Date().toISOString(),
            status: "error",
          },
        });
      }
      return;
    }

    for (let index = 1; index < CONNECT_PHASES.length; index++) {
      await new Promise((r) => setTimeout(r, 500));
      setConnectPhaseIndex(index);
    }
    await new Promise((r) => setTimeout(r, 350));

    if (state.selectedVendors.size === 0) {
      dispatch({ type: "SET_VENDORS", vendorIds: defaultVendorIds });
    }

    dispatch({ type: "UPDATE_EMAIL_STATUS", status: "connected" });
    setIsConnecting(false);
    setOauthStatus(`Connected ${targetEmail}`);
    onConnected?.();
  };

  const handleContinue = () => {
    if (onContinue) {
      onContinue();
      return;
    }

    if (state.guidedStep === "connect-email") {
      dispatch({ type: "SET_GUIDED_STEP", step: "select-vendors" });
      dispatch({ type: "OPEN_MODULE", module: "select-vendors" });
      return;
    }

    dispatch({ type: "OPEN_MODULE", module: "select-vendors" });
  };

  const canConnect = provider === "gmail" || Boolean(email.trim());

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_0.8fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Connect Your Email
          </CardTitle>
          <CardDescription>
            We'll scan your inbox for purchase orders, shipping confirmations, and
            invoices from your vendors to automatically detect products and order patterns.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connection?.status === "connected" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--arda-success)/0.3)] bg-[hsl(var(--arda-success)/0.06)] p-4">
                <MailCheck className="h-6 w-6 text-[hsl(var(--arda-success))]" />
                <div>
                  <p className="text-sm font-semibold text-[hsl(var(--arda-success))]">
                    Inbox linked. Ready to scan.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {connection.email} • {connection.provider}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-[hsl(var(--arda-blue)/0.22)] bg-[hsl(var(--arda-blue)/0.06)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
                Smart defaults enabled: {state.selectedVendors.size} vendor channels preselected for
                a fast first scan.
              </div>

              <Button className="w-full" onClick={handleContinue}>
                {state.guidedStep === "connect-email"
                  ? "Continue to vendor selection"
                  : "Continue to vendor selection"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                      provider === p.id
                        ? "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.06)]"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="text-xl">{p.icon}</span>
                    <span className="text-sm font-medium">{p.label}</span>
                  </button>
                ))}
              </div>

              {provider === "gmail" ? (
                <div className="rounded-lg border border-[hsl(var(--arda-blue)/0.22)] bg-[hsl(var(--arda-blue)/0.06)] px-3 py-2 text-xs text-[hsl(var(--arda-blue))]">
                  You&apos;ll continue to Google to choose which Gmail inbox to link.
                </div>
              ) : (
                <label className="form-label-arda">
                  Email Address
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="purchasing@company.com"
                  />
                </label>
              )}

              <Button
                className="w-full"
                disabled={!canConnect || isConnecting}
                onClick={() => void handleConnect()}
              >
                {isConnecting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {provider === "gmail" ? "Opening Google OAuth..." : "Linking inbox..."}
                  </span>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    {provider === "gmail" ? "Continue with Google" : "Connect Email"}
                  </>
                )}
              </Button>

              {oauthStatus && (
                <div className="rounded-md border border-[hsl(var(--arda-success)/0.25)] bg-[hsl(var(--arda-success)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-success))]">
                  {oauthStatus}
                </div>
              )}

              {oauthError && (
                <div className="rounded-md border border-[hsl(var(--arda-error)/0.25)] bg-[hsl(var(--arda-error)/0.08)] px-3 py-2 text-xs text-[hsl(var(--arda-error))]">
                  {oauthError}
                </div>
              )}

              {isConnecting && (
                <div className="space-y-2 rounded-xl border border-border/80 bg-muted/40 p-3">
                  {CONNECT_PHASES.map((phase, index) => {
                    const isComplete = index < connectPhaseIndex;
                    const isActive = index === connectPhaseIndex;

                    return (
                      <div key={phase} className="flex items-center gap-2 text-xs">
                        {isComplete ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--arda-success))]" />
                        ) : isActive ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--arda-blue))]" />
                        ) : (
                          <div className="h-3.5 w-3.5 rounded-full border border-border/80" />
                        )}
                        <span
                          className={cn(
                            "transition-colors",
                            isComplete && "text-[hsl(var(--arda-success))]",
                            isActive ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {phase}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-arda">
        <CardHeader>
          <CardTitle className="text-base">What we look for</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { icon: Package, label: "Purchase order confirmations" },
            { icon: Download, label: "Shipping & tracking notifications" },
            { icon: FileSpreadsheet, label: "Invoices and receipts" },
            { icon: Globe, label: "Vendor account notifications" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-3 text-sm">
              <div className="rounded-full bg-[hsl(var(--arda-blue)/0.1)] p-2">
                <Icon className="h-4 w-4 text-[hsl(var(--arda-blue))]" />
              </div>
              <span>{label}</span>
            </div>
          ))}

          <div className="mt-4 rounded-lg bg-muted p-3">
            <p className="text-xs text-muted-foreground">
              <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
              We only read purchase-related emails. Your personal messages are never accessed or stored.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
