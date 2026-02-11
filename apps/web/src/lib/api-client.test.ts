import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError } from "@/lib/api-client";

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
});
