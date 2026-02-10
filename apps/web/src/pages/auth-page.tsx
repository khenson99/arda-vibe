import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import { login, register, requestPasswordReset, resetPasswordWithToken, parseApiError } from "@/lib/api-client";
import type { AuthResponse } from "@/types";

export function AuthPage({ onAuthSuccess }: { onAuthSuccess: (response: AuthResponse) => void }) {
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
