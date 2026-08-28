// Auto-resume-on-reset: when an /app turn is cut off because the shared claude.ai subscription
// limit (5-hour session or 7-day weekly) was exhausted mid-turn, remember to re-run that turn once
// the window resets, instead of letting the conversation die. Default-on (Filip's call 2026-08-28),
// mirroring Claude Code's newer auto-resume.
//
// State persists to a JSON file OUTSIDE the repo (under the app state dir, alongside favourites/
// titles) so intents survive a service restart. A small in-process scheduler re-arms timers on
// startup and, at the reset (plus a short settle buffer), re-POSTs /app/api/start {resume,text}
// over loopback — the same resume path ct-redeploy uses. Non-enforcing and self-healing: a failed
// fire is retried, and the user simply interacting with the conversation cancels the pending resume.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ResumeIntent {
  convId: string;       // conversation/session id to resume
  text: string;         // the interrupted user turn to re-send
  resumeAt: number;     // unix ms when the limit window resets (we fire shortly after)
  rateLimitType?: string;
  createdAt: number;
}

const SETTLE_MS = 30_000; // fire this long AFTER resetsAt so the window has genuinely reset
const RETRY_MS = 5 * 60_000; // if a fire fails (still limited / service busy), try again in 5 min
const MAX_DELAY_MS = 8 * 24 * 3600_000; // clamp (the 7-day window is the longest we expect)

let FILE = "";
let PORT = 7682;
let OWNER = "filip";
let ready = false;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let intents: Record<string, ResumeIntent> = {};

function load(): void {
  try { if (existsSync(FILE)) intents = JSON.parse(readFileSync(FILE, "utf8")) || {}; } catch { intents = {}; }
}
function persist(): void {
  try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(intents, null, 2)); } catch { /* best-effort */ }
}
function clearTimer(convId: string): void { const t = timers.get(convId); if (t) { clearTimeout(t); timers.delete(convId); } }

async function fire(convId: string): Promise<void> {
  const it = intents[convId];
  if (!it) return;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/app/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Remote-User": OWNER },
      // cid dedupes a redelivery; keying it to resumeAt means one fire per scheduled reset.
      body: JSON.stringify({ resume: convId, text: it.text, cid: `autoresume-${convId}-${it.resumeAt}` }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      delete intents[convId];
      persist();
      clearTimer(convId);
      console.log(`auto-resume: resumed ${convId} after the subscription limit reset`);
    } else {
      console.error(`auto-resume ${convId}: HTTP ${res.status}, retrying in ${RETRY_MS / 60000}m`);
      scheduleRetry(convId);
    }
  } catch (e) {
    console.error(`auto-resume ${convId} failed, retrying:`, e);
    scheduleRetry(convId);
  }
}

function scheduleRetry(convId: string): void {
  clearTimer(convId);
  timers.set(convId, setTimeout(() => void fire(convId), RETRY_MS));
}

function schedule(convId: string): void {
  const it = intents[convId];
  if (!it) return;
  clearTimer(convId);
  let delay = it.resumeAt + SETTLE_MS - Date.now();
  // Floor past-due intents to 15s rather than firing instantly: prompt enough on startup, but a
  // guard against a hot loop if a resumed turn is somehow rejected again with a stale reset time.
  if (delay < 15_000) delay = 15_000;
  if (delay > MAX_DELAY_MS) delay = MAX_DELAY_MS;
  timers.set(convId, setTimeout(() => void fire(convId), delay));
}

// Record (or refresh) an intent to re-run a rate-limited turn at reset. Keeps the SOONEST reset if
// one already exists for this conversation. No-op until initSubscriptionResume() has run.
export function armResume(intent: ResumeIntent): void {
  if (!ready || !intent.convId || !intent.text || !intent.resumeAt) return;
  const prev = intents[intent.convId];
  if (prev && prev.resumeAt <= intent.resumeAt) { intents[intent.convId] = { ...intent, resumeAt: prev.resumeAt }; }
  else intents[intent.convId] = intent;
  persist();
  schedule(intent.convId);
}

// The user is actively continuing this conversation, so a pending auto-resume is no longer wanted.
export function cancelResume(convId: string): void {
  if (intents[convId]) { delete intents[convId]; persist(); }
  clearTimer(convId);
}

// Whether a resume is pending for this conversation (so a fired resume doesn't cancel itself).
export function hasResume(convId: string): boolean { return !!intents[convId]; }

// Load persisted intents on service startup and re-arm their timers (firing any already past).
export function initSubscriptionResume(opts: { file: string; port: number; owner: string }): void {
  FILE = opts.file; PORT = opts.port; OWNER = opts.owner;
  load();
  ready = true;
  const ids = Object.keys(intents);
  for (const id of ids) schedule(id);
  if (ids.length) console.log(`auto-resume: re-armed ${ids.length} pending intent(s) on startup`);
}

export function listResumeIntents(): ResumeIntent[] { return Object.values(intents); }
