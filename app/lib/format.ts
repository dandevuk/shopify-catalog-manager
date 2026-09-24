/**
 * Formats an ISO timestamp for display. A fixed locale and time zone make the
 * server render and the browser hydrate the same text.
 */
export function formatDateTime(iso: string): string {
  return `${new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
}
