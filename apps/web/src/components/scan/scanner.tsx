import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────

export interface ScannerProps {
  /** Called when a QR code is successfully decoded */
  onScan: (cardId: string) => void;
  /** Called when camera access fails */
  onCameraError?: (error: Error) => void;
  /** Whether the scanner is actively processing a scan */
  isProcessing?: boolean;
  /** Additional CSS classes */
  className?: string;
}

type CameraState = 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported';

// UUID v4 pattern for validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extract card ID from deep-link URL or raw UUID
function extractCardId(raw: string): string | null {
  const trimmed = raw.trim();

  // Direct UUID
  if (UUID_RE.test(trimmed)) {
    return trimmed;
  }

  // Deep-link URL: .../scan/{uuid}
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    const scanIndex = segments.indexOf('scan');
    if (scanIndex !== -1 && scanIndex + 1 < segments.length) {
      const candidate = segments[scanIndex + 1];
      if (UUID_RE.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Not a URL; ignore
  }

  return null;
}

// ─── Scanner Component ──────────────────────────────────────────────

export function Scanner({
  onScan: _onScan,
  onCameraError,
  isProcessing = false,
  className,
}: ScannerProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const animFrameRef = React.useRef<number>(0);

  const [cameraState, setCameraState] = React.useState<CameraState>('idle');
  const [lastError, setLastError] = React.useState<string | null>(null);

  // Cleanup camera on unmount
  React.useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  function stopCamera() {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  async function startCamera() {
    // Check browser support
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('unsupported');
      setLastError('Camera access is not supported in this browser.');
      onCameraError?.(new Error('getUserMedia not supported'));
      return;
    }

    setCameraState('requesting');
    setLastError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraState('active');
        scanLoop();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Camera access denied');
      setCameraState('denied');
      setLastError('Camera access denied. Use manual lookup below.');
      onCameraError?.(error);
    }
  }

  function scanLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      animFrameRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // QR decoding placeholder:
    // In production, integrate a QR decoder library (e.g., jsQR, zxing-wasm).
    // The decoder would process the ImageData from the canvas:
    //
    //   const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    //   const result = jsQR(imageData.data, imageData.width, imageData.height);
    //   if (result) {
    //     const cardId = extractCardId(result.data);
    //     if (cardId) { onScan(cardId); stopCamera(); return; }
    //   }
    //
    // For now, the scanner just displays the camera feed.
    // Manual lookup is the functional fallback.

    animFrameRef.current = requestAnimationFrame(scanLoop);
  }

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardContent className="p-0">
        {/* Camera viewfinder */}
        <div className="relative aspect-square w-full bg-black">
          <video
            ref={videoRef}
            className={cn(
              'h-full w-full object-cover',
              cameraState !== 'active' && 'hidden',
            )}
            playsInline
            muted
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Overlay states */}
          {cameraState === 'idle' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted">
              <svg
                className="h-12 w-12 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z"
                />
              </svg>
              <Button
                onClick={startCamera}
                disabled={isProcessing}
                className="rounded-md"
              >
                Open Camera
              </Button>
            </div>
          )}

          {cameraState === 'requesting' && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">
                  Requesting camera access...
                </p>
              </div>
            </div>
          )}

          {(cameraState === 'denied' || cameraState === 'unsupported') && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted p-6">
              <div className="flex flex-col items-center gap-3 text-center">
                <svg
                  className="h-10 w-10 text-muted-foreground"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
                <p className="text-sm font-semibold text-foreground">
                  {lastError ?? 'Camera not available'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Use manual lookup below to enter the card ID.
                </p>
              </div>
            </div>
          )}

          {/* Scanning overlay (viewfinder guide) */}
          {cameraState === 'active' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-48 w-48 rounded-xl border-2 border-white/60" />
              {isProcessing && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-white border-t-transparent" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Camera controls */}
        {cameraState === 'active' && (
          <div className="flex items-center justify-center gap-2 p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                stopCamera();
                setCameraState('idle');
              }}
              disabled={isProcessing}
            >
              Stop Camera
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Export the utility for testing
export { extractCardId, UUID_RE };
