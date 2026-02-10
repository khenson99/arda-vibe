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
import { useImportContext, nextId } from "../import-context";
import {
  buildMobileImportUrl,
  buildQrCodeImageUrl,
  isMobileImportMode,
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
  const [manualUpc, setManualUpc] = React.useState("");
  const [isCameraScanning, setIsCameraScanning] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);

  const mobileScannerUrl = React.useMemo(() => buildMobileImportUrl("scan-upcs"), []);
  const qrEncodesLocalhost = React.useMemo(
    () => (mobileScannerUrl ? isLikelyLocalhost(mobileScannerUrl) : false),
    [mobileScannerUrl],
  );
  const mobileScannerQrUrl = React.useMemo(
    () => (mobileScannerUrl ? buildQrCodeImageUrl(mobileScannerUrl) : ""),
    [mobileScannerUrl],
  );

  const videoRef = React.useRef<HTMLVideoElement>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);
  const scanTimeoutRef = React.useRef<number | null>(null);
  const scanLoopActiveRef = React.useRef(false);
  const barcodeDetectorRef = React.useRef<InstanceType<BarcodeDetectorCtor> | null>(null);

  const registerUpc = React.useCallback((rawUpc: string) => {
    const upc = rawUpc.trim();
    if (!upc) return;

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

    // Simulate lookup
    setTimeout(() => {
      const resolved = Math.random() > 0.2;
      dispatch({
        type: "UPDATE_UPC_SCAN",
        id,
        update: {
          status: resolved ? "resolved" : "not-found",
          resolvedProduct: resolved
            ? {
                name: `UPC Product ${upc.slice(-4)}`,
                upc,
                moq: Math.floor(Math.random() * 50 + 10),
              }
            : undefined,
        },
      });
    }, 1500);
  }, [dispatch]);

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

    const BarcodeDetector = getBarcodeDetectorCtor();
    if (!BarcodeDetector) {
      setCameraError("Barcode scanning is not supported in this mobile browser. Enter UPC manually.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is unavailable in this browser. Enter UPC manually.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
        },
        audio: false,
      });
      mediaStreamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stopCameraScanner();
        return;
      }

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
      setCameraError("Could not access phone camera. Check permissions and retry.");
    }
  }, [isCameraScanning, runDetectionLoop, stopCameraScanner]);

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

          {qrEncodesLocalhost && (
            <p className="text-xs text-red-600">
              QR links currently point to localhost. Set <code>VITE_PUBLIC_APP_URL</code> to a public app URL for real phone scanning.
            </p>
          )}

          <p className="text-xs text-muted-foreground">UPC lookups in this screen are currently simulated demo matches.</p>

          {/* Manual entry */}
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
