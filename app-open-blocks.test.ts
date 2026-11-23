// A chat reopened mid-reply must get the half-written block in its snapshot (openBlocks), or the rest
// of the reply arrives as a bubble with no opening fence (2026-11-23, voiceprint chat raw HTML).
import { test, expect } from "bun:test";
import { Conversation } from "./app-runner";
import { parseAssistant } from "./app/artifacts";

const se = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null });

test("open blocks cover the streamed text until its message is in the transcript", () => {
  const c = new Conversation("t-open", { cwd: "/tmp" } as any);
  const h = (m: unknown) => (c as any).handle(m);
  h(se({ type: "message_start", message: { id: "msg_1" } }));
  h(se({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
  h(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "```html\n<!doctype html><title>T</title>\n" } }));
  h(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<p>half" } }));
  // The client reopens here: snapshot = transcript (nothing of this block) + open blocks, cursor = seq.
  const snap = c.openBlocks();
  const cursor = c.seq;
  expect(snap).toEqual([{ t: "text", text: "```html\n<!doctype html><title>T</title>\n<p>half", bid: "msg_1:0" }]);
  h(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "</p>\n```\nDone." } }));
  h(se({ type: "content_block_stop", index: 0 }));
  // What the resumed stream sends after the cursor, folded onto the snapshot by bid.
  let text = (snap[0] as { text: string }).text;
  for (const e of (c as any).log as any[]) if (e._seq > cursor && e.t === "text_delta" && e.bid === "msg_1:0") text += e.text;
  const segs = parseAssistant(text);
  expect(segs.map((s) => s.type)).toEqual(["artifact", "markdown"]);
  // Closed, but its message is not handed back yet: still open.
  expect(c.openBlocks().length).toBe(1);
  h({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "x" }] } });
  expect(c.openBlocks()).toEqual([]);
});

test("result clears every open block", () => {
  const c = new Conversation("t-open2", { cwd: "/tmp" } as any);
  const h = (m: unknown) => (c as any).handle(m);
  h(se({ type: "message_start", message: { id: "msg_2" } }));
  h(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } }));
  expect(c.openBlocks().length).toBe(1);
  h({ type: "result", subtype: "success", usage: {}, modelUsage: {} });
  expect(c.openBlocks()).toEqual([]);
});
