// Phone bridge, pure parts: config, Twilio signature, TwiML, caller routing, spoken text.
// Ported from Brandon McDonald's deploy/phone/bridge.py (brandmcd/claude-terminal 178451b).
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

//#region config
export type PhoneUser = {
  name: string;        // Authelia / sidecar user name, sent as remote-user
  numbers: string[];   // E.164 caller ids that route to this user
  sidecar: string;     // that user's claude-terminal sidecar, e.g. http://127.0.0.1:7682
  cwd?: string;        // chat cwd; omitted = the sidecar's default
};

export type PhoneConfig = {
  publicUrl: string;          // https origin Twilio calls, no trailing slash
  port: number;
  from: string;               // the Twilio number, E.164
  sayVoice: string;
  speechModel: string;
  speechTimeout: number;      // seconds of silence that end an utterance
  holdSeconds: number;        // wait on the line this long, then switch to a callback
  sayLimit: number;           // characters read aloud; the rest stays in the app
  attestation: string[];      // accepted StirVerstat values
  speakerUrl: string;         // voiceprint service
  threshold: number;          // minimum voiceprint score
  minSpeechMs: number;        // voiced audio needed before a voiceprint decision
  enrollMinMs: number;        // voiced audio one enrolment sentence must hold
  learnScore: number;         // a passed call at or above this score adds its audio to the voiceprint
  maxSamples: number;         // voiceprint samples kept per device
  users: PhoneUser[];
};

export const DEFAULTS: PhoneConfig = {
  publicUrl: "https://call.filipkin.com",
  port: 7715,
  from: "",
  sayVoice: "Polly.Matthew-Neural",
  speechModel: "phone_call",
  speechTimeout: 1,
  holdSeconds: 120,
  sayLimit: 1500,
  attestation: ["TN-Validation-Passed-A"],
  speakerUrl: "http://127.0.0.1:7803",
  threshold: 0.6,
  minSpeechMs: 1200,
  enrollMinMs: 2000,
  learnScore: 0.75,
  maxSamples: 20,
  users: [],
};

export function loadConfig(path: string): PhoneConfig {
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<PhoneConfig>) : {};
  return { ...DEFAULTS, ...file };
}

/** Rewrite one key of config.json, keeping the rest. Atomic, so a reader never sees half a file. */
export function saveConfigKey<K extends keyof PhoneConfig>(path: string, key: K, value: PhoneConfig[K]): void {
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<PhoneConfig>) : {};
  writeFileSync(path + ".tmp", JSON.stringify({ ...file, [key]: value }, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

/** The owner's sidecar is 7682; a guest's is its ttyd port + 100 (add-guest.sh). null = not a user. */
export function sidecarFor(user: string, owner: string, guestsTsv: string): string | null {
  if (user === owner) return "http://127.0.0.1:7682";
  if (!existsSync(guestsTsv)) return null;
  const row = readFileSync(guestsTsv, "utf8").split("\n").map((l) => l.trim().split(/\s+/)).find((r) => r[0] === user);
  const port = row ? Number(row[1]) : NaN;
  return Number.isInteger(port) ? `http://127.0.0.1:${port + 100}` : null;
}

export type LinkResult = { ok: true; users: PhoneUser[] } | { ok: false; why: "not-a-number" | "in-use" | "own-number" };

/** One number per user, one user per number. Linking replaces the user's earlier number. */
export function linkNumber(cfg: PhoneConfig, user: string, sidecar: string, raw: string): LinkResult {
  const n = e164(raw);
  if (!n) return { ok: false, why: "not-a-number" };
  if (n === e164(cfg.from)) return { ok: false, why: "own-number" };
  if (cfg.users.some((u) => u.name !== user && u.numbers.some((x) => e164(x) === n))) return { ok: false, why: "in-use" };
  return { ok: true, users: [...cfg.users.filter((u) => u.name !== user), { name: user, numbers: [n], sidecar }] };
}
//#endregion

//#region callers
/** "+1 (248) 555-0100" and "2485550100" both become "+12485550100". Empty or non-numeric stays "". */
export function e164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/\d{7,}/.test(digits)) return "";
  if (digits.startsWith("+")) return digits;
  return digits.length === 10 ? "+1" + digits : "+" + digits;
}

export function userForCaller(cfg: PhoneConfig, from: string): PhoneUser | null {
  const n = e164(from);
  if (!n) return null;
  return cfg.users.find((u) => u.numbers.some((x) => e164(x) === n)) ?? null;
}

export type Admission =
  | { ok: true; user: PhoneUser }
  | { ok: false; why: "unknown-caller" | "attestation" };

/** Caller id picks the user; the carrier's attestation says the caller id is not spoofed. */
export function admit(cfg: PhoneConfig, from: string, stirVerstat: string): Admission {
  const user = userForCaller(cfg, from);
  if (!user) return { ok: false, why: "unknown-caller" };
  if (!cfg.attestation.includes(stirVerstat)) return { ok: false, why: "attestation" };
  return { ok: true, user };
}

export type VoiceCheck = { enrolled: boolean; score: number | null; speechMs: number };
export type VoiceVerdict = "pass" | "fail" | "short" | "not-enrolled";

export function voiceVerdict(cfg: PhoneConfig, v: VoiceCheck): VoiceVerdict {
  if (!v.enrolled) return "not-enrolled";
  if (v.speechMs < cfg.minSpeechMs || v.score === null) return "short";
  return v.score >= cfg.threshold ? "pass" : "fail";
}
//#endregion

//#region twilio
/** Twilio signs the full URL plus every POST parameter, sorted by name: HMAC-SHA1, base64. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function signatureOk(authToken: string, url: string, params: Record<string, string>, header: string): boolean {
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function twiml(...parts: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' + parts.join("") + "</Response>";
}

export const say = (cfg: PhoneConfig, text: string) => `<Say voice="${xml(cfg.sayVoice)}">${xml(text)}</Say>`;
export const play = (cfg: PhoneConfig, name: string) => `<Play>${cfg.publicUrl}/twilio/audio/${name}.wav</Play>`;
export const pause = (s: number) => `<Pause length="${s}"/>`;
export const redirect = (path: string) => `<Redirect>${path}</Redirect>`;
export const HANGUP = "<Hangup/>";

export function gather(cfg: PhoneConfig, inner = "", opts: { timeout?: number; speechTimeout?: number; action?: string } = {}): string {
  return `<Gather input="speech" action="${opts.action ?? "/twilio/heard"}" speechTimeout="${opts.speechTimeout ?? cfg.speechTimeout}" ` +
    `timeout="${opts.timeout ?? 6}" speechModel="${xml(cfg.speechModel)}" actionOnEmptyResult="true">${inner}</Gather>`;
}

/** Fork the caller's audio to the bridge for the voiceprint. The url takes no query string, so the
 *  per-call token rides in a custom parameter. */
export function startStream(cfg: PhoneConfig, token: string): string {
  const wss = cfg.publicUrl.replace(/^http/, "ws") + "/twilio/media";
  return `<Start><Stream url="${wss}" track="inbound_track"><Parameter name="token" value="${xml(token)}"/></Stream></Start>`;
}
//#endregion

//#region speech text
/** What is read aloud: no title tag, code, links or markdown marks. */
export function spoken(text: string, limit: number): string {
  let t = text.replace(/<title>[\s\S]*?<\/title>/g, "");
  t = t.replace(/```[\s\S]*?```/g, " (code is in the app) ");
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, "a link in the app");
  t = t.replace(/[*_`#>|]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > limit) t = t.slice(0, limit).replace(/\s+\S*$/, "") + ". The rest is in the app.";
  return t || "Done. Details are in the app.";
}

const BYE = /^(no|nope|that's it|that's all|bye|goodbye|nothing)[.!]?( thanks?( you)?)?[.!]?$/i;
export const isGoodbye = (text: string) => BYE.test(text.trim());

/** Fixed lines, rendered once by make-audio.ts. Key = clip name. */
export const LINES: Record<string, string> = {
  greet: "Claude here.",
  private: "This number is private.",
  not_recognised: "Voice not recognised.",
  retry_intro: "Voice not recognised. Say this after the tone.",
  not_enrolled: "No voice print on file.",
  say_more: "Say that again, a little longer.",
  on_it: "On it.",
  still_working: "Still working.",
  callback_later: "This takes a while. I will call back.",
  answer_intro: "Claude with your answer.",
  anything_else: "Anything else?",
  goodbye: "Goodbye.",
  broke: "Something failed. Details are in the app.",
  lost_track: "Call state lost. Call again.",
  sorry_catch: "I did not catch that.",
  result_in_app: "The answer is in the app.",
  enroll_intro: "Voice enrolment. Five sentences. Say each one after the tone.",
  enroll_again: "Once more.",
  enroll_failed: "Voice enrolment failed. No speech heard.",
  enroll_done: "Voice enrolment complete.",
};

/** Enrolment sentences. Between them they cover most English speech sounds; the line reads one,
 *  the caller repeats it after the tone. Clip names: enroll_p1 .. enroll_pN. */
export const PHRASES: string[] = [
  "The quick brown fox jumps over the lazy dog near the quiet river bank.",
  "She sells fresh orange juice and thick vanilla shakes at the market every Thursday.",
  "My father bought a huge yellow television which usually works with a joyful noise.",
  "Seven zebras chased through the treasure maze while the judge watched the show.",
  "Check the weather, read me the news, and remind me to call home at five.",
];
PHRASES.forEach((p, i) => { LINES[`enroll_p${i + 1}`] = p; });

/** Tones made by make-audio.ts: "tone" = your turn, "chime" = sentence accepted. */
export const TONES = ["tone", "chime"];

export type EnrollState = { label: string; done: number; misses: number };
export type EnrollStep = { kind: "next" | "again" | "done" | "failed"; state: EnrollState };
export const ENROLL_MAX_MISSES = 3;

/** One heard sentence: enough speech moves on to the next sentence, too little repeats the same
 *  one, and three misses in a call end it. state.done is also the index of the sentence to say. */
export function enrollStep(s: EnrollState, speechMs: number, minMs: number, total = PHRASES.length): EnrollStep {
  if (speechMs >= minMs) {
    const state = { ...s, done: s.done + 1 };
    return { kind: state.done >= total ? "done" : "next", state };
  }
  const state = { ...s, misses: s.misses + 1 };
  return { kind: state.misses >= ENROLL_MAX_MISSES ? "failed" : "again", state };
}

//#region voice check steps
export type VoiceTries = { shortTries: number; retried: boolean };
export type VoiceStep = "pass" | "say-more" | "retry" | "refuse";

/** What a voice verdict does to the call. Too little speech gets one "say more"; a failed score
 *  gets one retry on a read sentence (a longer, cleaner sample); anything else that is not a pass
 *  ends the call. No path reaches a prompt without a pass. */
export function voiceStep(verdict: "pass" | "fail" | "short" | "not-enrolled", t: VoiceTries): VoiceStep {
  if (verdict === "pass") return "pass";
  if (verdict === "short" && t.shortTries < 1) return "say-more";
  if (verdict === "fail" && !t.retried) return "retry";
  return "refuse";
}

/** Devices a voiceprint can belong to; each sounds different on a call. */
export const DEVICES = ["phone", "watch", "speaker", "car"] as const;

export type KeptClip = { stem: string; score: number | null; speechMs: number; adopted?: string };
export type RefusedCall = { call: string; at: string; score: number | null; clips: string[] };
export const CLIP_STEM = /^(\d{8})-(\d{6})-([A-Za-z0-9]{1,8})$/;

/** Kept clips (calls/<user>/<stem>.json) grouped into refused calls, newest first. A call is
 *  refused when none of its clips reached the threshold; an adopted call is no longer listed. */
export function refusedCalls(clips: KeptClip[], threshold: number, limit = 5): RefusedCall[] {
  const by = new Map<string, KeptClip[]>();
  for (const c of clips) {
    const m = CLIP_STEM.exec(c.stem);
    if (m) by.set(m[3], [...(by.get(m[3]) ?? []), c]);
  }
  const out: RefusedCall[] = [];
  for (const [call, list] of by) {
    if (list.some((c) => c.adopted || (c.score !== null && c.score >= threshold))) continue;
    list.sort((a, b) => a.stem.localeCompare(b.stem));
    const scores = list.map((c) => c.score).filter((x): x is number => x !== null);
    const m = CLIP_STEM.exec(list[0].stem)!;
    const at = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4)}`;
    out.push({ call, at, score: scores.length ? Math.max(...scores) : null, clips: list.map((c) => c.stem) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
//#endregion
