import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export interface ManualLookupProps {
  /** Called when the operator submits a valid card ID */
  onSubmit: (cardId: string) => void;
  /** Whether a lookup is currently in progress */
  isProcessing?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// UUID v4 validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Manual Lookup Component ────────────────────────────────────────

export function ManualLookup({
  onSubmit,
  isProcessing = false,
  className,
}: ManualLookupProps) {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = value.trim();

    if (!trimmed) {
      setError('Please enter a card ID.');
      return;
    }

    if (!UUID_RE.test(trimmed)) {
      setError('Invalid format. Card ID must be a valid UUID (e.g., a0b1c2d3-e4f5-6789-abcd-ef0123456789).');
      return;
    }

    setError(null);
    onSubmit(trimmed);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    if (error) {
      setError(null);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    // Auto-submit if pasted value is a valid UUID
    const pasted = e.clipboardData.getData('text').trim();
    if (UUID_RE.test(pasted)) {
      // Let the paste happen, then submit on next tick
      setTimeout(() => {
        setError(null);
        onSubmit(pasted);
      }, 0);
    }
  }

  return (
    <Card className={cn('', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Manual Lookup</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Input
              ref={inputRef}
              type="text"
              placeholder="Enter card ID (UUID)"
              value={value}
              onChange={handleChange}
              onPaste={handlePaste}
              disabled={isProcessing}
              aria-label="Card ID"
              aria-invalid={!!error}
              aria-describedby={error ? 'manual-lookup-error' : undefined}
              className={cn(
                'font-mono text-sm',
                error && 'border-destructive focus-visible:ring-destructive',
              )}
            />
            {error && (
              <p
                id="manual-lookup-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={isProcessing || !value.trim()}
              className="rounded-md"
            >
              {isProcessing ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Looking up...
                </span>
              ) : (
                'Look Up Card'
              )}
            </Button>

            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setValue('');
                  setError(null);
                  inputRef.current?.focus();
                }}
                disabled={isProcessing}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
