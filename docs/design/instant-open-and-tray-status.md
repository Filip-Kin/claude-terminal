# Instant open: background cache (Android) + tray status — design

Status: design only, no feature code written. Written 2026-08-30 against commit 4517fd0 (build 1p18k7vb).
Platform target: **Android Chrome installed PWA is the target. iOS gets the degraded path and is not a
design constraint.**

## The goal

Open the app and immediately see everything, with no network in the path and no waiting. Cache kept
current in the background, not only while the app is open.

## Answer: yes, this works well on Android

And there is a neat convergence. The tray status notification you asked for first turns out to be the
**vehicle** for the background caching, not a separate feature. Android will not let a service worker
wake up without showing something, but it will let that something be a **silent, in-place update to one
notification**. So you pay for the background wake-up with a notification you wanted anyway.

### Verified platform facts

Checked against current docs rather than memory, August 2026.

| Fact | Status |
| --- | --- |
| Silent push (wake the SW, show nothing) | **Not available.** Standard web push requires `userVisibleOnly: true`. Chrome 121 allows `false` for *extensions* only, not PWAs. |
| A notification replaced via the same `tag` with `renotify: false` updates **without sound or vibration** | **Confirmed.** This is the mechanism the whole design rests on. |
| Periodic Background Sync (`periodicsync`) | **Confirmed useless here.** Chrome enforces a 12 hour minimum gap between events, plus engagement heuristics. |
| One-shot Background Sync (`sync`) fires when connectivity returns | **Confirmed**, Android only. We already use it for the send queue (sw.js:104). |
| Chrome push rate limits | **Confirmed and not a problem for us.** Determined daily from notifications-sent vs engagement; the floor even when limited is 1000/min, then HTTP 429. Penalties escalate 1 day, 7 days, 14 days, reset after 42 clean days. It targets high-volume low-engagement sites. Your engagement with this PWA is about as high as a site gets. |
| Badging API (`navigator.setAppBadge`) | Available on Android. Not implemented anywhere in this repo today. |
| Service worker lifetime per push | Seconds, up to roughly 30s inside `event.waitUntil`. Bounded work only. |

## The design: push is a doorbell, not a transport

The obvious version, stuffing transcript data into the push payload, hits a wall: push payloads cap
around 4KB, so one tool call with a decent diff blows the budget. So do not send the data. Send a
pointer, and let the service worker go and fetch it.

**Server**

1. Track a per-conversation sequence number. The events already carry `_seq` (app-runner.ts:398), so
   this is mostly exposing what exists.
2. While any conversation is active, a coalescer fires **one push every N seconds** (start at 15s) if
   anything advanced. Not one per event. Nothing is sent when everything is idle.
3. Payload is small and fixed-shape: the fleet summary for the notification text, plus a list of
   `{convId, seq}` that moved. Always well under 4KB.
4. Send the cadence pushes **only to subscriptions that can take them.** More on this below.

**Service worker**, inside one `waitUntil`:

1. `showNotification` with a fixed tag, `renotify: false`, `silent: true`. Updates the one tray entry in
   place, no sound, no vibration. This satisfies `userVisibleOnly` and is also the status display.
2. For each advanced conversation, read the cached seq from IndexedDB and fetch
   `/app/api/conversation/:id?since=<cachedSeq>`, then write the delta with the existing `conv_items` /
   `conv_meta` schema (offline.ts:18-19).
3. `navigator.setAppBadge(waitingCount)`.

**On idle:** one final push, notification updated to the finished state, badge cleared.

Because the push carries a pointer rather than the data, one small push can catch the cache up on an
arbitrary amount of work, and the 4KB cap stops mattering.

### What this gets you

Open the app: everything is already in IndexedDB, current to within about 15 seconds, and the first
paint needs no network at all. The delta on open is usually nothing, sometimes tiny.

## Prerequisites, and four defects that must be fixed anyway

The doorbell design needs a delta endpoint. That was already the right fix for the open path, because I
measured where the waiting actually comes from and it is four things in our own code, none of them a
cold cache.

**1. No timeout on any read.** `withTimeout` exists (main.tsx:103) but is wired only to `send`, `start`,
`edit` (main.tsx:1537, 1538, 1632). Every read is a bare fetch (main.tsx:110-137). `loadConv` awaits
`api.conversation(id)` inside `setLoadingConv(true)` (main.tsx:1376), so a link that **hangs** rather
than fails never settles the promise and the spinner never clears. This is your "waiting for a
connection to go through". Client-only fix, ships with `build:app`, no restart.

**2. Every open refetches the whole transcript.** `/app/api/conversation/:id` returns every event, always
(app-server.ts:505-512). No `since`. You pull hundreds of KB to learn about three missed messages, over
the worst link. **The `?since=` delta endpoint fixes this and is the prerequisite for the doorbell.**

**3. The prewarm caches each conversation once and never updates it.**
`if (await offline.hasConv(c.sessionId)) continue;` (main.tsx:987). Your most-used chats are frozen at
first-cache, so the cache-first paint is showing you old content. You were right that the cache is not
being kept current.

**4. Boot is five independent requests** (main.tsx:1087-1097), each able to stall. Worth collapsing into
one boot endpoint later.

Also needs changing: `conv_meta` gains a `seq` field so the SW knows where to resume from, and sw.js
currently sets `renotify: !!data.tag` (sw.js:148), which re-alerts on every tagged push. That has to
become opt-in per payload or the status notification will buzz every 15 seconds.

## Honest costs

- **Battery.** One radio wake plus a short service worker run every 15s **while agents are active**, and
  nothing at all when idle. That is roughly a messaging app with a live conversation open. Tunable: 30s
  or 60s cadence cuts it proportionally and you would barely notice the difference on open.
- **Rate limits.** Not a concern at this cadence given your engagement, per the numbers above.
- **A notification is always visible while agents are active.** That is the price of the wake-up. It is
  silent and it updates in place, so it is one quiet tray entry, not a stream of alerts. If you do not
  want a permanent tray entry while things run, the whole approach does not work, so this is the one
  thing to be sure about.
- **Best-effort.** If the SW's delta fetch fails, the cache just stays where it was and the app catches
  up on open through the same endpoint. Nothing breaks.

## iOS, since you asked me not to care

I will not design around it, but I do need to avoid actively making it worse: if the 15s cadence pushes
go to an iPhone, it will alert on most of them. So subscriptions get a capability flag at subscribe
time and the cadence pushes go only to Android endpoints. iOS keeps exactly what it has today, plus the
delta endpoint and the timeout fixes, which help it anyway. That is a few lines, not a workstream.

## Recommendation and sequencing

1. **Defect 1 (read timeouts).** Client-only, no restart, ships immediately. Removes the infinite spinner.
2. **Delta endpoint + `conv_meta.seq` + prewarm refresh (defects 2 and 3).** One `ct-redeploy`. Big win
   on its own even before any push work.
3. **The doorbell push: coalescer, SW handler, badge, renotify fix.** The background cache proper.
4. Later if wanted: single boot endpoint (defect 4), SSE `Last-Event-ID` resume.

Steps 1 and 2 are roughly one session. Step 3 is a second session and is where the real design risk sits
(cadence tuning, the notification copy, idle transitions).

## Built 2026-08-30 (commit fea2571, local only: NOT deployed, NOT pushed)

Measured on real data, not estimated:

| Thing | Before | After |
| --- | --- | --- |
| Catch up on 2 new events in a 306-event chat | 359,972 bytes | 2,396 bytes |
| Re-establish the cursor after a live turn | full transcript | 272 bytes (`?meta=1`) |
| Already up to date | full transcript | `delta:true`, 0 events |

Verified:
- Delta endpoint against a real transcript, including an out-of-range cursor falling back to a full
  send so a diverged cache self-heals.
- Coalescer unit-tested through a full episode: first activity pushes, a busy-but-quiet cycle does
  NOT push, a conversation parked on a question does NOT re-push every cycle (found and fixed during
  testing, it would have been a wasted radio wake every 15s for as long as a question sat unanswered),
  the finished count is right, and it goes silent when idle.
- The real `sw.js` driven by a real push in headless Chromium via CDP: it pulled exactly the 3 missing
  events and advanced the cursor. The untrusted-cursor guard was tested separately and correctly
  skipped rather than parking duplicates.

Known residual risks:
- **Untested on a real handset.** Everything above is a headless browser and a local server. The
  silent-tagged-update behaviour, actual battery cost, and whether the tray entry feels right are all
  device-side and need a day of real use.
- **Cursor re-establish has a small race.** It adopts the server's event count 3s after a turn ends,
  on the assumption the SDK has flushed the turn to the jsonl by then. If it has not, the next fold
  could duplicate one message. Guarded by only adopting while the conversation is idle. If duplicates
  ever appear after a turn, this is the first place to look.
- **The service worker's fetch depends on the Authelia session cookie.** If the session has expired
  while the app is closed, the delta fetch fails and the cache simply stays where it was. Best-effort
  by design, but it means a long absence gets no warming until you next open the app.
- Conversations never opened on that device are not warmed (nothing cached to top up). They are picked
  up by the prewarm once the app is open.

## Questions before code

1. **The permanent tray entry.** A silent, in-place-updating notification sitting in the tray the whole
   time any agent is active is unavoidable on Android. Fine, or a dealbreaker?
2. **Cadence.** Start at 15s while active? 30s halves the battery cost and you would rarely notice.
3. **Scope.** Cache-warm only conversations you have open or recently touched, or every active one?
   Everything active is more pushes and more SW work; recent-only is cheaper and probably enough.
4. **Ship order.** Want defect 1 out on its own today as a client-only build, then batch 2 and 3? Or one
   larger batch with a single restart?

Sources for the platform facts:
- [Periodic Background Sync (Chrome for Developers)](https://developer.chrome.com/docs/capabilities/periodic-background-sync)
- [Web Periodic Background Synchronization API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API)
- [Subscribe a user to push notifications (web.dev)](https://web.dev/articles/push-notifications-subscribing-a-user)
- [Notification behaviour (web.dev)](https://web.dev/articles/push-notifications-notification-behaviour)
- [Notification.renotify (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Notification/renotify)
- [Increasing web push notification value with rate limits (Chrome for Developers)](https://developer.chrome.com/blog/web-push-rate-limits)
