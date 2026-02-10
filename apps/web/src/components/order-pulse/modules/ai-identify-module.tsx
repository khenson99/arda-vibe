import * as React from "react";
import { Camera, ImagePlus, Loader2, QrCode } from "lucide-react";

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import {
  createMobileImportSession,
  fetchMobileImportSession,
  identifyImageWithAi,
  parseApiError,
  readStoredSession,
  submitMobileImportImage,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { AiPrediction } from "../types";
import { useImportContext, nextId } from "../import-context";
import {
  buildMobileImportSessionUrl,
  buildMobileImportUrl,
  buildQrCodeImageUrl,
  isMobileImportMode,
  readMobileImportSessionParams,
} from "../mobile-links";

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

async function optimizeImageDataUrl(file: File): Promise<string> {
  const rawDataUrl = await fileToDataUrl(file);
  if (rawDataUrl.length <= 1_200_000) return rawDataUrl;

  try {
    const bitmap = await createImageBitmap(file);
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longestEdge > 1400 ? 1400 / longestEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return rawDataUrl;

    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return rawDataUrl;
  }
}

export function AiIdentifyModule() {
  const { state, dispatch } = useImportContext();
  const { imageIdentifications: images } = state;

  const isMobileFlow = React.useMemo(() => isMobileImportMode(), []);
  const mobileSessionParams = React.useMemo(() => readMobileImportSessionParams(), []);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const lastPolledSequenceRef = React.useRef(0);

  const [desktopSession, setDesktopSession] = React.useState<{
    sessionId: string;
    sessionToken: string;
  } | null>(null);
  const [syncMessage, setSyncMessage] = React.useState<string | null>(null);

  const mobileCaptureUrl = React.useMemo(() => {
    if (desktopSession) {
      return buildMobileImportSessionUrl(
        "ai-identify",
        desktopSession.sessionId,
        desktopSession.sessionToken,
      );
    }
    return buildMobileImportUrl("ai-identify");
  }, [desktopSession]);
  const mobileCaptureQrUrl = React.useMemo(
    () => (mobileCaptureUrl ? buildQrCodeImageUrl(mobileCaptureUrl) : ""),
    [mobileCaptureUrl],
  );

  const ingestImageDataUrl = React.useCallback(
    (
      input: {
        fileName: string;
        imageDataUrl: string;
      },
      options?: { skipServerSync?: boolean },
    ) => {
      const id = nextId("img");
      dispatch({
        type: "ADD_IMAGE_IDENTIFICATION",
        item: {
          id,
          imageDataUrl: input.imageDataUrl,
          fileName: input.fileName,
          uploadedAt: new Date().toISOString(),
          predictions: [],
          status: "analyzing",
        },
      });

      if (
        isMobileFlow &&
        !options?.skipServerSync &&
        mobileSessionParams.sessionId &&
        mobileSessionParams.sessionToken
      ) {
        void submitMobileImportImage({
          sessionId: mobileSessionParams.sessionId,
          sessionToken: mobileSessionParams.sessionToken,
          fileName: input.fileName,
          imageDataUrl: input.imageDataUrl,
        }).catch(() => {
          setSyncMessage("Could not sync this photo to desktop. Check connectivity and retry.");
        });
      }

      const accessToken = readStoredSession()?.tokens.accessToken;
      if (!accessToken) {
        if (isMobileFlow && !options?.skipServerSync) {
          dispatch({
            type: "UPDATE_IMAGE_IDENTIFICATION",
            id,
            update: {
              status: "complete",
              predictions: [],
            },
          });
          setSyncMessage("Photo synced to desktop. AI analysis runs on your desktop workspace.");
          return;
        }

        dispatch({
          type: "UPDATE_IMAGE_IDENTIFICATION",
          id,
          update: {
            status: "error",
            predictions: [],
          },
        });
        setSyncMessage("Sign in is required to run AI photo analysis.");
        return;
      }

      void (async () => {
        try {
          const analysis = await identifyImageWithAi(accessToken, {
            imageDataUrl: input.imageDataUrl,
            fileName: input.fileName,
          });

          const predictions = analysis.predictions.map((prediction) => ({
            ...prediction,
            confidence: Math.max(0, Math.min(1, prediction.confidence)),
            suggestedProduct: prediction.suggestedProduct
              ? {
                  ...prediction.suggestedProduct,
                  source: "ai-image" as const,
                }
              : undefined,
          }));

          dispatch({
            type: "UPDATE_IMAGE_IDENTIFICATION",
            id,
            update: {
              status: "complete",
              predictions,
            },
          });
        } catch (error) {
          dispatch({
            type: "UPDATE_IMAGE_IDENTIFICATION",
            id,
            update: {
              status: "error",
              predictions: [],
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
    setSyncMessage("This mobile camera link is not paired to a desktop session.");
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
        const created = await createMobileImportSession(accessToken, { module: "ai-identify" });
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
            if (event.type === "image") {
              ingestImageDataUrl(
                {
                  fileName: event.payload.fileName,
                  imageDataUrl: event.payload.imageDataUrl,
                },
                { skipServerSync: true },
              );
            }
            lastPolledSequenceRef.current = Math.max(lastPolledSequenceRef.current, event.sequence);
          }
        };

        await poll();
        pollTimer = window.setInterval(() => {
          void poll().catch(() => {
            setSyncMessage("Live mobile image sync lost. Trying to reconnect...");
          });
        }, 2000);
      } catch {
        if (!cancelled) {
          setSyncMessage("Could not start mobile sync session for image capture.");
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
  }, [ingestImageDataUrl, isMobileFlow]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      void (async () => {
        try {
          const imageDataUrl = await optimizeImageDataUrl(file);
          ingestImageDataUrl({
            fileName: file.name,
            imageDataUrl,
          });
        } catch {
          setSyncMessage("Could not process selected image.");
        }
      })();
    }

    e.target.value = "";
  };

  const handleSelectPrediction = (imgId: string, pred: AiPrediction) => {
    dispatch({
      type: "UPDATE_IMAGE_IDENTIFICATION",
      id: imgId,
      update: { selectedPrediction: pred },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Camera className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          AI Product Identification
        </CardTitle>
        <CardDescription>
          Upload photos of products and our AI will identify them, suggest matches, and
          extract relevant details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        {!isMobileFlow && (
          <div className="rounded-xl border border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-4">
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
              <div className="rounded-full bg-[hsl(var(--arda-blue)/0.12)] p-2">
                <QrCode className="h-4 w-4 text-[hsl(var(--arda-blue))]" />
              </div>
              <div className="text-center sm:text-left">
                <p className="text-sm font-semibold">Capture with phone camera</p>
                <p className="text-xs text-muted-foreground">
                  Scan to open a mobile-friendly image capture flow for AI analysis.
                </p>
              </div>
            </div>
            {mobileCaptureQrUrl && (
              <div className="mt-3 flex flex-col items-center gap-2">
                <img
                  src={mobileCaptureQrUrl}
                  alt="QR code to open mobile AI image capture workflow"
                  className="h-[170px] w-[170px] rounded-lg border bg-white p-2"
                />
                <a
                  href={mobileCaptureUrl}
                  className="text-xs text-[hsl(var(--arda-blue))] underline-offset-2 hover:underline"
                >
                  Open mobile image capture flow
                </a>
              </div>
            )}
          </div>
        )}

        {isMobileFlow && (
          <div className="rounded-xl border border-[hsl(var(--arda-blue)/0.35)] bg-[hsl(var(--arda-blue)/0.05)] p-4">
            <p className="text-sm font-semibold">Mobile capture mode</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Use your phone camera to take product photos for AI matching.
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[hsl(var(--arda-blue))] px-4 py-2 text-sm font-medium text-white"
            >
              <Camera className="h-4 w-4" />
              Take or upload photos
            </button>
          </div>
        )}

        {syncMessage && (
          <p className="text-xs text-red-600">{syncMessage}</p>
        )}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8 transition-colors hover:bg-[hsl(var(--arda-blue)/0.08)]"
        >
          <ImagePlus className="h-8 w-8 text-[hsl(var(--arda-blue))]" />
          <div className="text-center">
            <p className="text-sm font-semibold">Upload product images</p>
            <p className="text-xs text-muted-foreground mt-1">
              Drag and drop or click to browse. Supports JPG, PNG, WebP.
            </p>
          </div>
        </button>

        {images.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            {images.map((img) => (
              <div key={img.id} className="rounded-xl border bg-card overflow-hidden">
                <div className="aspect-video bg-muted relative">
                  <img
                    src={img.imageDataUrl}
                    alt={img.fileName}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  {img.status === "analyzing" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-sm font-medium">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Analyzing...
                      </div>
                    </div>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <p className="text-xs text-muted-foreground truncate">{img.fileName}</p>
                  {img.predictions.map((pred, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSelectPrediction(img.id, pred)}
                      className={cn(
                        "w-full rounded-lg border p-2 text-left transition-colors",
                        img.selectedPrediction === pred
                          ? "border-[hsl(var(--arda-blue)/0.4)] bg-[hsl(var(--arda-blue)/0.06)]"
                          : "hover:bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium">{pred.label}</span>
                        <Badge variant={pred.confidence >= 0.8 ? "success" : "warning"}>
                          {Math.round(pred.confidence * 100)}%
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
