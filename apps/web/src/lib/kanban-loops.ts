import { fetchLoops } from "@/lib/api-client";
import { partMatchesLinkId } from "@/lib/part-linking";
import type { KanbanLoop, PartRecord } from "@/types";

export async function fetchLoopsForPart(token: string, part: PartRecord): Promise<KanbanLoop[]> {
  const pageSize = 100;
  const matchingLoops: KanbanLoop[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const pageResult = await fetchLoops(token, { page, pageSize });
    matchingLoops.push(...pageResult.data.filter((loop) => partMatchesLinkId(part, loop.partId)));

    totalPages = Math.max(1, pageResult.pagination.totalPages || 1);
    page += 1;
  }

  return matchingLoops;
}
