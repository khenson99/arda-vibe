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
import { cn } from "@/lib/utils";
import type { AiPrediction, ProductSource } from "../types";
import { useImportContext, nextId } from "../import-context";
import {
  buildMobileImportUrl,
  buildQrCodeImageUrl,
  isMobileImportMode,
} from "../mobile-links";

export function AiIdentifyModule() {
  const { state, dispatch } = useImportContext();
  const { imageIdentifications: images } = state;

  const isMobileFlow = React.useMemo(() => isMobileImportMode(), []);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const mobileCaptureUrl = React.useMemo(() => buildMobileImportUrl("ai-identify"), []);
  const mobileCaptureQrUrl = React.useMemo(
    () => (mobileCaptureUrl ? buildQrCodeImageUrl(mobileCaptureUrl) : ""),
    [mobileCaptureUrl],
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      handleUpload(files[i]);
    }
    e.target.value = "";
  };

  const handleUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const id = nextId("img");
      dispatch({
        type: "ADD_IMAGE_IDENTIFICATION",
        item: {
          id,
          imageDataUrl: reader.result as string,
          fileName: file.name,
          uploadedAt: new Date().toISOString(),
          predictions: [],
          status: "analyzing",
        },
      });

      // Simulate AI analysis
      setTimeout(() => {
        dispatch({
          type: "UPDATE_IMAGE_IDENTIFICATION",
          id,
          update: {
            status: "complete",
            predictions: [
              {
                label: `Industrial Part (${file.name.split(".")[0]})`,
                confidence: 0.92,
                suggestedProduct: {
                  name: `AI-Identified: ${file.name.split(".")[0]}`,
                  source: "ai-image" as ProductSource,
                  moq: 25,
                },
              },
              {
                label: "Similar Component Match",
                confidence: 0.74,
                suggestedProduct: {
                  name: `Similar: ${file.name.split(".")[0]} variant`,
                  source: "ai-image" as ProductSource,
                  moq: 50,
                },
              },
            ],
          },
        });
      }, 2500);
    };
    reader.readAsDataURL(file);
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
