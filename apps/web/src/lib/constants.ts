export const DEFAULT_RAILWAY_API_BASE = "https://api-gateway-production-83fa.up.railway.app";

const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim();
export const API_BASE_URL = (
  RAW_API_BASE_URL || (import.meta.env.PROD ? DEFAULT_RAILWAY_API_BASE : "")
).replace(/\/+$/, "");

export const SESSION_STORAGE_KEY = "arda.web.session.v1";
export const ITEMS_PAGE_SIZE_STORAGE_KEY = "arda.web.items.pageSize.v1";
export const ITEMS_VISIBLE_COLUMNS_STORAGE_KEY = "arda.web.items.visibleColumns.v1";

export const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
