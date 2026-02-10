import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui";
import { ITEMS_PAGE_SIZE_OPTIONS } from "@/types";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  firstIndex: number;
  lastIndex: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function PaginationBar({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  firstIndex,
  lastIndex,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-table-border px-3 py-2 text-xs">
      <p className="text-muted-foreground">
        {totalItems === 0 ? "No items" : `${firstIndex} to ${lastIndex} of ${totalItems.toLocaleString()}`}
      </p>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-muted-foreground">
          Rows
          <select
            className="h-7 rounded-md border border-input bg-background px-2 text-foreground"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {ITEMS_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onPageChange(1)}
          disabled={currentPage <= 1}
          aria-label="First page"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="px-1 text-muted-foreground">
          Page {currentPage} of {totalPages}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage >= totalPages}
          aria-label="Last page"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
