// Proves the fix: the internal bookkeeping listener registered by getOrCreate must NOT make a
// conversation look "watched", or the idle sweeper skips it forever (the subprocess leak).
import { getOrCreate, get } from "./app-runner.ts";
let pass = 0, fail = 0;
const t = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

const c = getOrCreate("test-conv-1", { cwd: "/tmp" });
// Before the fix this was TRUE the instant the conversation existed (getOrCreate's own listener),
// so both reapIfIdle() and the 5-min sweeper skipped every conversation for the life of the process.
t("fresh conversation has no client subscribers", c.hasSubscribers() === false);

const off = c.subscribe(() => {});
t("a real SSE client makes it watched", c.hasSubscribers() === true);
off();
t("client disconnect makes it collectable again", c.hasSubscribers() === false);

const off2 = c.subscribe(() => {});
const off3 = c.subscribe(() => {});
off2();
t("still watched while one of two clients remains", c.hasSubscribers() === true);
off3();
t("collectable once the last client leaves", c.hasSubscribers() === false);

// The internal hook must still work: it registers the conversation under its real session id.
const c2 = getOrCreate("test-conv-2", { cwd: "/tmp" });
(c2 as any).emit({ t: "init", sessionId: "real-session-id-xyz" });
t("internal hook still re-keys the conversation on init", get("real-session-id-xyz") === c2);
t("internal hook did not become a client subscriber", c2.hasSubscribers() === false);

// The sweeper's guards: busy or parked-on-a-question must never be collected.
const c3 = getOrCreate("test-conv-3", { cwd: "/tmp" });
c3.busy = true;
t("a working conversation reports busy (sweeper skips it)", c3.statusInfo().busy === true);
c3.busy = false;
(c3 as any).pendingAsks.set("a1", () => {});
t("a conversation parked on a question reports waiting (sweeper skips it)", c3.statusInfo().waiting === true);

// Activity must refresh the idle clock, or a long turn with no client attached looks idle.
const c4 = getOrCreate("test-conv-4", { cwd: "/tmp" });
(c4 as any).lastActivity = Date.now() - 60 * 60_000; // an hour stale
(c4 as any).emit({ t: "text_delta", text: "x" });
t("streamed output refreshes the idle clock", Date.now() - c4.lastActivity < 1000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
