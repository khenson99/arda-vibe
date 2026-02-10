import { describe, expect, it } from "vitest";
import { resolveLoopLabel } from "../card-label-designer";

describe("resolveLoopLabel", () => {
  it("returns known loop labels from LOOP_META", () => {
    expect(resolveLoopLabel("procurement")).toBe("Procurement");
    expect(resolveLoopLabel("production")).toBe("Production");
    expect(resolveLoopLabel("transfer")).toBe("Transfer");
  });

  it("falls back to a readable label for unknown loop types", () => {
    expect(resolveLoopLabel("quality_hold")).toBe("Quality Hold");
  });

  it("returns null when loop type is missing", () => {
    expect(resolveLoopLabel(undefined)).toBeNull();
    expect(resolveLoopLabel(null)).toBeNull();
    expect(resolveLoopLabel("")).toBeNull();
  });
});
