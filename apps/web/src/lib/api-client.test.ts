import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiRequest,
  ApiError,
  createProcurementDrafts,
  fetchLoopCardSummary,
} from "@/lib/api-client";

describe("apiRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses JSON error bodies even when content-type is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Service unavailable",
          service: "/api/kanban",
        }),
        {
          status: 502,
        },
      ),
    );

    let captured: unknown;
    try {
      await apiRequest("/api/kanban/loops");
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as ApiError).message).toBe("Service unavailable");
    expect((captured as ApiError).status).toBe(502);
    expect((captured as ApiError).details?.service).toBe("/api/kanban");
  });

  it("parses JSON success bodies even when content-type is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: "loop-1" }],
        }),
        {
          status: 200,
        },
      ),
    );

    const payload = await apiRequest<{ data: Array<{ id: string }> }>("/api/kanban/loops");
    expect(payload.data).toEqual([{ id: "loop-1" }]);
  });

  it("normalizes lifecycle card summary stageCounts into byStage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          loopId: "loop-1",
          totalCards: 4,
          stageCounts: { created: 1, triggered: 2, ordered: 1 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const summary = await fetchLoopCardSummary("token", "loop-1");
    expect(summary).toEqual({
      loopId: "loop-1",
      totalCards: 4,
      byStage: { created: 1, triggered: 2, ordered: 1 },
    });
  });

  it("retries create-drafts against compatibility alias when primary route returns 404", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response("<pre>Cannot POST /queue/procurement/create-drafts</pre>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              supplierId: "sup-1",
              recipientEmail: "buyer@example.com",
              drafts: [],
              totalDrafts: 0,
              totalCards: 0,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const result = await createProcurementDrafts("token", {
      supplierId: "sup-1",
      lines: [
        {
          cardId: "8d1117ff-ef99-44af-87f9-d2228cdf67d8",
          quantityOrdered: 1,
          orderMethod: "purchase_order",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/orders/queue/procurement/create-drafts");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/orders/queue/create-drafts");
    expect(result.supplierId).toBe("sup-1");
  });
});
