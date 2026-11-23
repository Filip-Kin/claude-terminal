#!/usr/bin/env bun
// Render the bridge's fixed lines once with the local Kokoro TTS (claude-tts, :7802), so only
// Claude's answers go through Twilio's billed <Say>. Run again after changing LINES in lib.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LINES, TONES } from "./lib";

const STATE = process.env.PHONE_STATE || "/var/lib/claude-phone";
const TTS = process.env.TTS_URL || "http://127.0.0.1:7802";
const VOICE = process.env.PHONE_VOICE || "am_michael";

mkdirSync(join(STATE, "audio"), { recursive: true });
for (const [name, text] of Object.entries(LINES)) {
  const r = await fetch(TTS + "/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice: VOICE, speed: 1 }) });
  if (!r.ok) throw new Error(`${name}: TTS ${r.status} ${await r.text()}`);
  await Bun.write(join(STATE, "audio", name + ".wav"), await r.arrayBuffer());
  console.log(name, r.headers.get("x-audio-seconds") + " s");
}

//#region tones
/** Sine notes with a short fade, 24 kHz PCM16 mono WAV. */
function wav(notes: [hz: number, ms: number][]): Uint8Array {
  const sr = 24000, samples: number[] = [];
  for (const [hz, ms] of notes) {
    const n = Math.round((sr * ms) / 1000), fade = sr * 0.012;
    for (let i = 0; i < n; i++) samples.push(Math.sin((2 * Math.PI * hz * i) / sr) * 0.35 * Math.min(1, i / fade, (n - i) / fade));
  }
  const buf = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, t: string) => [...t].forEach((ch, i) => buf.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); buf.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVEfmt "); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, sr, true); buf.setUint32(28, sr * 2, true);
  buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); str(36, "data"); buf.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => buf.setInt16(44 + i * 2, Math.round(v * 32767), true));
  return new Uint8Array(buf.buffer);
}
const NOTES: Record<string, [number, number][]> = { tone: [[880, 220]], chime: [[660, 110], [990, 170]] };
for (const name of TONES) { await Bun.write(join(STATE, "audio", name + ".wav"), wav(NOTES[name])); console.log(name, "tone"); }
//#endregion
