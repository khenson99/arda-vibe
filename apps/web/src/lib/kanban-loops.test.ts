import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLoops } from "@/lib/api-client";
import { fetchLoopsForPart } from "@/lib/kanban-loops";
import type { PartRecord } from "@/types";

vi.mock("@/lib/api-client", () => ({
  fetchLoops: vi.fn(),
}));

describe("fetchLoopsForPart", () => {
  const fetchLoopsMock = vi.mocked(fetchLoops);
  const token = "token-123";
  const part = {
    id: "PART-1",
    eId: "legacy-1",
    externalGuid: "ext-1",
  } as PartRecord;

  const makeLoop = (id: string, partId: string) =>
    ({ id, partId }) as Awaited<ReturnType<typeof fetchLoops>>["data"][number];

  beforeEach(() => {
    fetchLoopsMock.mockReset();
  });

  it("walks all pages and returns loops linked to the part", async () => {
    fetchLoopsMock
      .mockResolvedValueOnce({
        data: [makeLoop("loop-a", "other")],
        pagination: { page: 1, pageSize: 100, total: 3, totalPages: 3 },
      })
      .mockResolvedValueOnce({
        data: [makeLoop("loop-b", "LEGACY-1")],
        pagination: { page: 2, pageSize: 100, total: 3, totalPages: 3 },
      })
      .mockResolvedValueOnce({
        data: [makeLoop("loop-c", "not-a-match")],
        pagination: { page: 3, pageSize: 100, total: 3, totalPages: 3 },
      });

    const result = await fetchLoopsForPart(token, part);

    expect(fetchLoopsMock).toHaveBeenCalledTimes(3);
    expect(fetchLoopsMock).toHaveBeenNthCalledWith(1, token, { page: 1, pageSize: 100 });
    expect(fetchLoopsMock).toHaveBeenNthCalledWith(2, token, { page: 2, pageSize: 100 });
    expect(fetchLoopsMock).toHaveBeenNthCalledWith(3, token, { page: 3, pageSize: 100 });
    expect(result).toEqual([makeLoop("loop-b", "LEGACY-1")]);
  });

  it("returns an empty array when no loops match", async () => {
    fetchLoopsMock.mockResolvedValueOnce({
      data: [makeLoop("loop-a", "other")],
      pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
    });

    const result = await fetchLoopsForPart(token, part);

    expect(fetchLoopsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
