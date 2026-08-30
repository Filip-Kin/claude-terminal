// Coalesced status push: one silent, in-place notification update while agents are working, which
// doubles as the wake-up that lets the service worker pull transcript deltas into the offline cache.
//
// Why it is shaped like this: Android will not wake a service worker without a visible notification
// (userVisibleOnly is the only subscription kind browsers issue), but a notification replaced under the
// same tag with renotify:false updates with no sound or vibration. So the tray entry is the price of
// the background wake-up, and we make it useful by having it BE the status display.
//
// The push carries POINTERS, never transcript data: push payloads cap around 4KB and one tool call
// with a real diff blows that. It names the conversations that moved and the SW fetches their deltas
// itself, so one small push can catch the cache up on an arbitrary amount of work.

export interface ConvActivity { id: string; busy: boolean; waiting: boolean; activitySeq: number }
export interface StatusPayload {
  kind: "status";
  title: string;
  body: string;
  working: number;
  waiting: number;
  finished: number;
  convs: string[];   // advanced since the last push; the SW pulls a delta for each
  idle: boolean;     // final update of this episode; the SW clears the badge
  at: number;
}
export interface StatusPushOpts {
  intervalMs: number;
  snapshot: () => ConvActivity[];
  push: (payload: StatusPayload) => void;
}

// An "episode" is one continuous stretch of work. It starts when something first goes busy and ends
// when everything is idle again; `finished` counts within it so the closing notification can say how
// many turns completed rather than a meaningless lifetime total.
export function buildStatus(working: number, waiting: number, finished: number, idle: boolean): { title: string; body: string } {
  if (idle) {
    return { title: finished === 1 ? "Finished" : "All finished", body: finished > 0 ? `${finished} conversation${finished === 1 ? "" : "s"} finished` : "Nothing running" };
  }
  // Lead with the actionable part: a waiting agent is the only state that needs you to do something.
  const bits: string[] = [];
  if (working > 0) bits.push(`${working} working`);
  if (finished > 0) bits.push(`${finished} finished`);
  if (waiting > 0) return { title: waiting === 1 ? "1 waiting for you" : `${waiting} waiting for you`, body: bits.join(", ") || "Tap to answer" };
  return { title: working === 1 ? "1 agent working" : `${working} agents working`, body: bits.slice(1).join(", ") || "Running" };
}

export function startStatusPush(opts: StatusPushOpts): () => void {
  const lastSeq = new Map<string, number>();
  const wasBusy = new Set<string>();
  let episodeActive = false;
  let finished = 0;
  let lastWaitingKey = "";

  const tick = () => {
    let snap: ConvActivity[];
    try { snap = opts.snapshot(); } catch { return; }

    const working = snap.filter((c) => c.busy);
    const waiting = snap.filter((c) => c.waiting);

    // Count turns that ended since the last tick, for the "did any finish" half of the ask.
    const liveIds = new Set(snap.map((c) => c.id));
    for (const id of [...wasBusy]) {
      const still = snap.find((c) => c.id === id);
      // Gone from the map entirely (reaped) counts as finished, not as still-running.
      if (!still || !still.busy) { wasBusy.delete(id); if (episodeActive) finished++; }
    }
    for (const c of working) wasBusy.add(c.id);
    for (const id of [...lastSeq.keys()]) if (!liveIds.has(id)) lastSeq.delete(id); // don't leak reaped convs

    // Scope: only conversations that are actively OUTPUTTING get their delta pulled. An idle
    // conversation cannot have new events, so pushing for it would be a wasted radio wake.
    const advanced = working.filter((c) => (lastSeq.get(c.id) ?? -1) !== c.activitySeq).map((c) => c.id);
    for (const c of working) lastSeq.set(c.id, c.activitySeq);

    if (working.length || waiting.length) {
      if (!episodeActive) { episodeActive = true; finished = 0; }
      // Quiet tick: nothing new to fetch and the waiting set is unchanged. Skip it rather than spend a
      // push, so neither a long silent turn nor a conversation parked on a question wakes the radio
      // every cycle. Keyed on the SET, not the count, so swapping which agent is waiting still pushes.
      const waitingKey = waiting.map((c) => c.id).sort().join(",");
      if (!advanced.length && waitingKey === lastWaitingKey) return;
      lastWaitingKey = waitingKey;
      const { title, body } = buildStatus(working.length, waiting.length, finished, false);
      opts.push({ kind: "status", title, body, working: working.length, waiting: waiting.length, finished, convs: advanced, idle: false, at: Date.now() });
      return;
    }

    // Everything idle. One closing update, then stay quiet until work starts again.
    if (episodeActive) {
      episodeActive = false;
      lastWaitingKey = "";
      const { title, body } = buildStatus(0, 0, finished, true);
      opts.push({ kind: "status", title, body, working: 0, waiting: 0, finished, convs: advanced, idle: true, at: Date.now() });
      finished = 0;
    }
  };

  const t = setInterval(tick, opts.intervalMs);
  // Don't hold the process open for a purely cosmetic timer.
  if (typeof (t as unknown as { unref?: () => void }).unref === "function") (t as unknown as { unref: () => void }).unref();
  return () => clearInterval(t);
}
