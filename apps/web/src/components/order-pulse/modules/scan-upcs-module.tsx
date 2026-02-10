import * as React from "react";
import { Loader2, QrCode, ScanBarcode } from "lucide-react";

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
import {
  createMobileImportSession,
  fetchMobileImportSession,
  lookupUpc,
  parseApiError,
  readStoredSession,
  submitMobileImportUpc,
} from "@/lib/api-client";
import { useImportContext, nextId } from "../import-context";
import {
  buildMobileImportSessionUrl,
  buildMobileImportUrl,
  buildQrCodeImageUrl,
  isMobileImportMode,
  readMobileImportSessionParams,
} from "../mobile-links";

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const maybeCtor = (window as Window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return maybeCtor ?? null;
}

function isLikelyLocalhost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function ScanUpcsModule() {
  const { state, dispatch } = useImportContext();
  const { upcScans: scans } = state;

  const isMobileFlow = React.useMemo(() => isMobileImportMode(), []);
  const mobileSessionParams = React.useMemo(() => readMobileImportSessionParams(), []);

  const [manualUpc, setManualUpc] = React.useState("");
  const [isCameraScanning, setIsCameraScanning] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [syncMessage, setSyncMessage] = React.useState<string | null>(null);
  const [desktopSession, setDesktopSession] = React.useState<{
    sessionId: string;
    sessionToken: string;
  } | null>(null);

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);
  const scanTimeoutRef = React.useRef<number | null>(null);
  const scanLoopActiveRef = React.useRef(false);
  const barcodeDetectorRef = React.useRef<InstanceType<BarcodeDetectorCtor> | null>(null);
  const zxingControlsRef = React.useRef<{ stop: () => void } | null>(null);
  const zxingReaderActiveRef = React.useRef(false);
  const lastPolledSequenceRef = React.useRef(0);

  const mobileScannerUrl = React.useMemo(() => {
    if (desktopSession) {
      return buildMobileImportSessionUrl(
        "scan-upcs",
        desktopSession.sessionId,
        desktopSession.sessionToken,
      );
    }
    return buildMobileImportUrl("scan-upcs");
  }, [desktopSession]);

  const qrEncodesLocalhost = React.useMemo(
    () => (mobileScannerUrl ? isLikelyLocalhost(mobileScannerUrl) : false),
    [mobileScannerUrl],
  );
  const mobileScannerQrUrl = React.useMemo(
    () => (mobileScannerUrl ? buildQrCodeImageUrl(mobileScannerUrl) : ""),
    [mobileScannerUrl],
  );

  const registerUpc = React.useCallback(
    (rawUpc: string, options?: { skipServerSync?: boolean }) => {
      const upc = rawUpc.trim();
      if (!upc) return;
      if (!/^\d{8,14}$/.test(upc)) {
        setSyncMessage("UPC must be 8-14 digits.");
        return;
      }

      const id = nextId("upc");

      dispatch({
        type: "ADD_UPC_SCAN",
        item: {
          id,
          upc,
          scannedAt: new Date().toISOString(),
          status: "pending",
        },
      });
      setManualUpc("");

      if (
        isMobileFlow &&
        !options?.skipServerSync &&
        mobileSessionParams.sessionId &&
        mobileSessionParams.sessionToken
      ) {
        void submitMobileImportUpc({
          sessionId: mobileSessionParams.sessionId,
          sessionToken: mobileSessionParams.sessionToken,
          upc,
        }).catch(() => {
          setSyncMessage("Could not sync this scan to desktop. Check connectivity and retry.");
        });
      }
      const accessToken = readStoredSession()?.tokens.accessToken;
      if (!accessToken) {
        if (isMobileFlow && !options?.skipServerSync) {
          setSyncMessage("Scan synced to desktop. Product lookup will run there.");
          return;
        }
        dispatch({
          type: "UPDATE_UPC_SCAN",
          id,
          update: {
            status: "not-found",
          },
        });
        setSyncMessage("Sign in is required for live UPC lookup.");
        return;
      }

      void (async () => {
        try {
          const lookup = await lookupUpc(accessToken, upc);
          if (lookup.found && lookup.product) {
            dispatch({
              type: "UPDATE_UPC_SCAN",
              id,
              update: {
                status: "resolved",
                resolvedProduct: {
                  name: lookup.product.name,
                  upc: lookup.product.upc,
                  moq: lookup.product.moq ?? 1,
                  description: lookup.product.description,
                  imageUrl: lookup.product.imageUrl,
                },
              },
            });
            return;
          }

          dispatch({
            type: "UPDATE_UPC_SCAN",
            id,
            update: {
              status: "not-found",
            },
          });
        } catch (error) {
          dispatch({
            type: "UPDATE_UPC_SCAN",
            id,
            update: {
              status: "not-found",
            },
          });
          setSyncMessage(parseApiError(error));
        }
      })();
    },
    [dispatch, isMobileFlow, mobileSessionParams.sessionId, mobileSessionParams.sessionToken],
  );

  React.useEffect(() => {
    if (!isMobileFlow) return;
    if (mobileSessionParams.sessionId && mobileSessionParams.sessionToken) return;
    setSyncMessage("This mobile scanner link is not paired to a desktop session.");
  }, [isMobileFlow, mobileSessionParams.sessionId, mobileSessionParams.sessionToken]);

  React.useEffect(() => {
    if (isMobileFlow) return;

    const session = readStoredSession();
    const accessToken = session?.tokens.accessToken;
    if (!accessToken) return;

    let cancelled = false;
    let pollTimer: number | null = null;

    const start = async () => {
      try {
        const created = await createMobileImportSession(accessToken, { module: "scan-upcs" });
        if (cancelled) return;

        setDesktopSession({
          sessionId: created.sessionId,
          sessionToken: created.sessionToken,
        });
        setSyncMessage(null);
        lastPolledSequenceRef.current = 0;

        const poll = async () => {
          const snapshot = await fetchMobileImportSession({
            sessionId: created.sessionId,
            accessToken,
            sinceSequence: lastPolledSequenceRef.current,
          });
          for (const event of snapshot.events) {
            if (event.type === "upc") {
              registerUpc(event.payload.upc, { skipServerSync: true });
            }
            lastPolledSequenceRef.current = Math.max(lastPolledSequenceRef.current, event.sequence);
          }
        };

        await poll();
        pollTimer = window.setInterval(() => {
          void poll().catch(() => {
            setSyncMessage("Live mobile sync lost. Trying to reconnect...");
          });
        }, 2000);
      } catch {
        if (!cancelled) {
          setSyncMessage("Could not start mobile sync session for this step.");
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
    };
  }, [isMobileFlow, registerUpc]);

  const stopCameraScanner = React.useCallback(() => {
    scanLoopActiveRef.current = false;

    if (scanTimeoutRef.current !== null) {
      window.clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }

    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }

    zxingReaderActiveRef.current = false;
    const zxingControls = zxingControlsRef.current;
    if (zxingControls) {
      zxingControls.stop();
      zxingControlsRef.current = null;
    }

    barcodeDetectorRef.current = null;
    setIsCameraScanning(false);
  }, []);

  const runDetectionLoop = React.useCallback(async () => {
    if (!scanLoopActiveRef.current) return;
    const detector = barcodeDetectorRef.current;
    const video = videoRef.current;
    if (!detector || !video) return;

    try {
      const codes = await detector.detect(video);
      const matchedCode = codes.find((code) => {
        const value = code.rawValue?.trim();
        return Boolean(value && /\d{8,14}/.test(value));
      });

      if (matchedCode?.rawValue) {
        registerUpc(matchedCode.rawValue);
        stopCameraScanner();
        return;
      }
    } catch {
      // Detection errors are transient while camera exposure/focus settles.
    }

    scanTimeoutRef.current = window.setTimeout(() => {
      void runDetectionLoop();
    }, 240);
  }, [registerUpc, stopCameraScanner]);

  const startCameraScanner = React.useCallback(async () => {
    if (isCameraScanning) return;
    setCameraError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is unavailable in this browser. Enter UPC manually.");
      return;
    }

    try {
      const video = videoRef.current;
      if (!video) {
        setCameraError("Camera preview could not be initialized.");
        return;
      }

      const BarcodeDetector = getBarcodeDetectorCtor();
      if (!BarcodeDetector) {
        const zxing = await import("@zxing/browser");
        const reader = new zxing.BrowserMultiFormatReader(undefined, {
          delayBetweenScanAttempts: 180,
        });
        zxingReaderActiveRef.current = true;
        setIsCameraScanning(true);
        zxingControlsRef.current = await reader.decodeFromConstraints(
          {
            video: {
              facingMode: { ideal: "environment" },
            },
          },
          video,
          (result, error) => {
            if (!zxingReaderActiveRef.current) return;
            if (result) {
              const value = result.getText().trim();
              if (/\d{8,14}/.test(value)) {
                registerUpc(value);
                stopCameraScanner();
                return;
              }
            }
            if (error && (error as Error).name !== "NotFoundException") {
              setCameraError("Scanner is running, but barcode decoding is unstable. Try better lighting.");
            }
          },
        );
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
        },
        audio: false,
      });
      mediaStreamRef.current = stream;

      video.srcObject = stream;
      await video.play();

      barcodeDetectorRef.current = new BarcodeDetector({
        formats: ["upc_a", "upc_e", "ean_13", "ean_8", "code_128"],
      });

      scanLoopActiveRef.current = true;
      setIsCameraScanning(true);
      void runDetectionLoop();
    } catch {
      stopCameraScanner();
      setCameraError("Could not start camera scanning. Check camera permission and retry.");
    }
  }, [isCameraScanning, registerUpc, runDetectionLoop, stopCameraScanner]);

  React.useEffect(() => {
    return () => {
      stopCameraScanner();
    };
  }, [stopCameraScanner]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualUpc.trim()) return;
    registerUpc(manualUpc);
    setManualUpc("");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <QrCode className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
            Scan UPCs from Your Phone
          </CardTitle>
          <CardDescription>
            {isMobileFlow
              ? "Use your phone camera to scan barcodes directly in this mobile flow."
              : "Scan this QR code with your phone to open the mobile barcode scanner. Scanned items will appear here in real-time."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isMobileFlow && (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8">
              {mobileScannerQrUrl && (
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <img
                    src={mobileScannerQrUrl}
                    alt="QR code to open mobile UPC scanner workflow"
                    className="h-[180px] w-[180px] rounded-lg"
                  />
                </div>
              )}
              <div className="text-center">
                <p className="text-sm font-semibold">Point your phone camera here</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Opens this workspace&apos;s mobile UPC capture flow.
                </p>
                {mobileScannerUrl && (
                  <a
                    href={mobileScannerUrl}
                    className="mt-2 inline-flex text-xs text-[hsl(var(--arda-blue))] underline-offset-2 hover:underline"
                  >
                    Open mobile UPC flow
                  </a>
                )}
              </div>
            </div>
          )}

          {isMobileFlow && (
            <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.35)] bg-[hsl(var(--arda-blue)/0.05)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    if (isCameraScanning) {
                      stopCameraScanner();
                    } else {
                      void startCameraScanner();
                    }
                  }}
                  variant={isCameraScanning ? "outline" : "default"}
                >
                  <ScanBarcode className="h-4 w-4" />
                  {isCameraScanning ? "Stop scanner" : "Start camera scanner"}
                </Button>
                <Badge variant={isCameraScanning ? "success" : "secondary"}>
                  {isCameraScanning ? "Scanning..." : "Ready"}
                </Badge>
              </div>
              {cameraError && (
                <p className="mt-2 text-xs text-red-600">{cameraError}</p>
              )}
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className="mt-3 w-full overflow-hidden rounded-lg border bg-black/80"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Hold barcode steady in frame. Detected UPCs are added automatically.
              </p>
            </div>
          )}

          {syncMessage && (
            <p className="text-xs text-red-600">{syncMessage}</p>
          )}

          {qrEncodesLocalhost && (
            <p className="text-xs text-red-600">
              QR links currently point to localhost. Set <code>VITE_PUBLIC_APP_URL</code> to a public app URL for real phone scanning.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            UPC lookups are resolved against live providers (BarcodeLookup/OpenFoodFacts).
          </p>

          <form onSubmit={handleManualSubmit} className="flex gap-2">
            <Input
              value={manualUpc}
              onChange={(e) => setManualUpc(e.target.value)}
              placeholder="Or type UPC manually..."
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={!manualUpc.trim()}>
              <ScanBarcode className="h-4 w-4" />
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scanned Items ({scans.length})</CardTitle>
          <CardDescription>
            Products identified from barcode scans
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
          {scans.length === 0 && (
            <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
              No barcodes scanned yet. Use the QR code or manual entry above.
            </p>
          )}

          {scans.map((scan) => (
            <div key={scan.id} className="card-order-item">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-mono font-semibold">{scan.upc}</p>
                  {scan.resolvedProduct?.name && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {scan.resolvedProduct.name}
                    </p>
                  )}
                </div>
                <Badge
                  variant={
                    scan.status === "resolved"
                      ? "success"
                      : scan.status === "pending"
                        ? "secondary"
                        : "warning"
                  }
                >
                  {scan.status === "pending" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                  {scan.status}
                </Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
