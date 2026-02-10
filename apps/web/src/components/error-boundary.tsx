import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, Card, CardContent } from "@/components/ui";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Route-level error boundary that catches rendering errors and shows
 * a user-friendly recovery UI instead of a blank screen.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <SomeRoute />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-[300px] items-center justify-center p-6">
          <Card className="max-w-md">
            <CardContent className="space-y-4 p-6 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--arda-error)/0.1)]">
                <AlertTriangle className="h-6 w-6 text-[hsl(var(--arda-error))]" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Something went wrong</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  An unexpected error occurred. Try refreshing or contact support if the issue persists.
                </p>
              </div>
              {this.state.error && (
                <pre className="max-h-24 overflow-auto rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
                  {this.state.error.message}
                </pre>
              )}
              <div className="flex justify-center gap-3">
                <Button variant="outline" size="sm" onClick={this.handleReset}>
                  <RefreshCw className="h-4 w-4" />
                  Try Again
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  Reload Page
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
