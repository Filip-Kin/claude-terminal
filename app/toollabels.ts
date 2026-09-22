// app/toollabels.ts — display names for MCP tool calls in the chat.
//
// A tool card used to show the raw SDK id ("mcp__shop__search_amazon") and a JSON dump of the input.
// For the built-in servers (google, shop, app-ui) this maps each tool to a short label and picks the
// one input value worth showing (the query, the listing id, the subject...). Any other MCP tool gets
// "server · tool" with the underscores turned into words. Non-MCP tools (Bash, Read...) return null
// and keep their existing rendering.

const LABELS: Record<string, string> = {
  // shop
  "shop:search_amazon": "Amazon search",
  "shop:search_ebay": "eBay search",
  "shop:compare_prices": "Price comparison",
  "shop:amazon_item": "Amazon listing",
  "shop:ebay_item": "eBay listing",
  "shop:amazon_cart_link": "Amazon cart link",
  "shop:present_results": "Shopping results",
  // app-ui
  "app-ui:ask_user": "Question",
  // google
  "google:google_accounts": "Google · Accounts",
  "google:calendar_list_calendars": "Calendar · Calendars",
  "google:calendar_list_events": "Calendar · Events",
  "google:calendar_get_event": "Calendar · Event",
  "google:calendar_create_event": "Calendar · New event",
  "google:calendar_quick_add_event": "Calendar · Quick add",
  "google:calendar_update_event": "Calendar · Event edit",
  "google:calendar_delete_event": "Calendar · Event delete",
  "google:calendar_respond_to_event": "Calendar · RSVP",
  "google:calendar_find_free_time": "Calendar · Free time",
  "google:gmail_search": "Gmail · Search",
  "google:gmail_get_message": "Gmail · Message",
  "google:gmail_get_thread": "Gmail · Thread",
  "google:gmail_list_labels": "Gmail · Labels",
  "google:gmail_modify_labels": "Gmail · Label change",
  "google:gmail_create_draft": "Gmail · Draft",
  "google:gmail_send": "Gmail · Send",
  "google:gmail_trash": "Gmail · Trash",
  "google:drive_search": "Drive · Search",
  "google:drive_read": "Drive · File",
  "google:drive_create_file": "Drive · New file",
  "google:drive_create_folder": "Drive · New folder",
  "google:drive_update_content": "Drive · File edit",
  "google:drive_organise": "Drive · Move",
  "google:drive_share": "Drive · Share",
  "google:drive_list_permissions": "Drive · Sharing",
  "google:drive_trash": "Drive · Trash",
  "google:sheets_info": "Sheets · Spreadsheet",
  "google:sheets_read": "Sheets · Read",
  "google:sheets_update": "Sheets · Cell edit",
  "google:sheets_append": "Sheets · New rows",
  "google:sheets_clear": "Sheets · Clear",
  "google:sheets_create": "Sheets · New spreadsheet",
  "google:docs_read": "Docs · Document",
  "google:docs_create": "Docs · New document",
  "google:docs_append": "Docs · Append",
  "google:docs_replace": "Docs · Replace",
  "google:tasks_list_lists": "Tasks · Lists",
  "google:tasks_list": "Tasks · Tasks",
  "google:tasks_create": "Tasks · New task",
  "google:tasks_update": "Tasks · Task edit",
  "google:tasks_delete": "Tasks · Task delete",
  "google:contacts_search": "Contacts · Search",
  "google:contacts_list": "Contacts · Contacts",
  "google:contacts_create": "Contacts · New contact",
};

// Input fields worth showing next to the label, in priority order.
const SUMMARY_KEYS = [
  "query", "q", "text", "question", "title", "summary", "subject", "to", "name",
  "asin", "itemId", "item_id", "range", "find", "documentId", "spreadsheetId", "fileId", "eventId", "timeMin",
];

const words = (s: string) => s.replace(/_/g, " ");

export function toolDisplay(name: string, input: unknown): { label: string; summary: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  if (!m) return null;
  const [, server, tool] = m;
  const label = LABELS[`${server}:${tool}`] || `${server} · ${words(tool)}`;
  let summary = "";
  const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const k of SUMMARY_KEYS) {
    const v = inp[k];
    if (typeof v === "string" && v.trim()) { summary = v.trim(); break; }
    if (typeof v === "number") { summary = String(v); break; }
  }
  if (!summary) { try { const j = JSON.stringify(inp); summary = j === "{}" ? "" : j.slice(0, 120); } catch { /* */ } }
  return { label, summary: summary.slice(0, 160) };
}
