import * as React from "react";
import {
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  FileSpreadsheet,
  Globe,
  Link2,
  Loader2,
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import type { EnrichedProduct, ProductSource } from "../types";
import { useImportContext, nextId } from "../import-context";

interface ImportLinksModuleProps {
  mode?: "links" | "csv" | "both";
}

export function ImportLinksModule({ mode = "both" }: ImportLinksModuleProps) {
  const { state, dispatch } = useImportContext();
  const { linkImports: links, csvResult } = state;

  const [linkText, setLinkText] = React.useState("");
  const csvInputRef = React.useRef<HTMLInputElement>(null);

  const handleAddLinks = () => {
    const urls = linkText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"));
    if (urls.length === 0) return;

    const items = urls.map((url) => ({
      id: nextId("link"),
      url,
      status: "pending" as const,
    }));
    dispatch({ type: "ADD_LINK_IMPORTS", items });
    setLinkText("");

    // Deterministic lightweight scrape stub so onboarding is stable.
    for (const item of items) {
      setTimeout(
        () => {
          let hostname = "product-link";
          try {
            hostname = new URL(item.url).hostname.replace(/^www\./, "");
          } catch {
            hostname = "product-link";
          }

          dispatch({
            type: "UPDATE_LINK_IMPORT",
            id: item.id,
            update: {
              status: "scraped",
              scrapedProduct: {
                name: `Imported from ${hostname}`,
                productUrl: item.url,
                source: "link-scrape" as ProductSource,
                moq: 10,
              },
              errorMessage: undefined,
            },
          });
        },
        800,
      );
    }
  };

  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.trim().split("\n");
      const headers = lines[0]?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
      const nameIdx = headers.findIndex((h) => h.includes("name") || h.includes("product"));
      const skuIdx = headers.findIndex((h) => h.includes("sku") || h.includes("part"));
      const qtyIdx = headers.findIndex(
        (h) => h.includes("qty") || h.includes("quantity") || h.includes("moq"),
      );

      const parsedItems: Partial<EnrichedProduct>[] = [];
      const errors: { row: number; message: string }[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map((c) => c.trim());
        const name = nameIdx >= 0 ? cols[nameIdx] : undefined;
        if (!name) {
          errors.push({ row: i + 1, message: "Missing product name" });
          continue;
        }
        parsedItems.push({
          name,
          sku: skuIdx >= 0 ? cols[skuIdx] : undefined,
          moq: qtyIdx >= 0 ? parseInt(cols[qtyIdx], 10) || 0 : 0,
          source: "csv-upload",
        });
      }

      dispatch({
        type: "SET_CSV_RESULT",
        result: {
          fileName: file.name,
          totalRows: lines.length - 1,
          parsedItems,
          errors,
        },
      });
    };
    reader.readAsText(file);
  };

  const linksCard = (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Import from Product Links
        </CardTitle>
        <CardDescription>
          Paste product URLs (one per line) and we'll scrape product details from those pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <textarea
          value={linkText}
          onChange={(e) => setLinkText(e.target.value)}
          placeholder={"https://amazon.com/dp/B0XXXXX\nhttps://mcmaster.com/12345\nhttps://uline.com/product/S-XXXXX"}
          rows={5}
          className="form-input-arda resize-none font-mono text-xs"
        />
        <Button onClick={handleAddLinks} disabled={!linkText.trim()}>
          <Globe className="h-4 w-4" />
          Scrape Links
        </Button>

        {links.length > 0 && (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {links.map((link) => (
              <div key={link.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                {link.status === "pending" || link.status === "scraping" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
                ) : link.status === "scraped" ? (
                  <CheckCircle2 className="h-4 w-4 text-[hsl(var(--arda-success))] flex-shrink-0" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-[hsl(var(--arda-error))] flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono truncate">{link.url}</p>
                  {link.scrapedProduct?.name && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      &rarr; {link.scrapedProduct.name}
                    </p>
                  )}
                  {link.errorMessage && (
                    <p className="text-xs text-[hsl(var(--arda-error))] mt-0.5">
                      {link.errorMessage}
                    </p>
                  )}
                </div>
                <Badge
                  variant={
                    link.status === "scraped"
                      ? "success"
                      : link.status === "error"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {link.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const csvCard = (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-5 w-5 text-[hsl(var(--arda-blue))]" />
          Upload CSV Spreadsheet
        </CardTitle>
        <CardDescription>
          Upload a CSV file with product information. Expected columns: Name/Product,
          SKU/Part Number, Quantity/MOQ.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,.tsv"
          className="hidden"
          onChange={handleCsvChange}
        />
        <button
          type="button"
          onClick={() => csvInputRef.current?.click()}
          className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[hsl(var(--arda-blue)/0.3)] bg-[hsl(var(--arda-blue)/0.04)] p-8 transition-colors hover:bg-[hsl(var(--arda-blue)/0.08)]"
        >
          <CloudUpload className="h-8 w-8 text-[hsl(var(--arda-blue))]" />
          <div className="text-center">
            <p className="text-sm font-semibold">Upload CSV file</p>
            <p className="text-xs text-muted-foreground mt-1">
              Drag and drop or click to browse
            </p>
          </div>
        </button>

        {csvResult && (
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{csvResult.fileName}</p>
              <Badge variant="accent">{csvResult.totalRows} rows</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-[hsl(var(--arda-success)/0.06)] border border-[hsl(var(--arda-success)/0.2)] p-3 text-center">
                <p className="text-xl font-bold text-[hsl(var(--arda-success))]">
                  {csvResult.parsedItems.length}
                </p>
                <p className="text-xs text-muted-foreground">Parsed Successfully</p>
              </div>
              <div className="rounded-lg bg-[hsl(var(--arda-error)/0.06)] border border-[hsl(var(--arda-error)/0.2)] p-3 text-center">
                <p className="text-xl font-bold text-[hsl(var(--arda-error))]">
                  {csvResult.errors.length}
                </p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (mode === "links") return linksCard;
  if (mode === "csv") return csvCard;

  return (
    <Tabs defaultValue="links" className="space-y-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="links">
          <Link2 className="h-4 w-4 mr-2" />
          Paste Links
        </TabsTrigger>
        <TabsTrigger value="csv">
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Upload CSV
        </TabsTrigger>
      </TabsList>
      <TabsContent value="links">{linksCard}</TabsContent>
      <TabsContent value="csv">{csvCard}</TabsContent>
    </Tabs>
  );
}

export function UploadCsvModule() {
  return <ImportLinksModule mode="csv" />;
}
