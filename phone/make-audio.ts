#!/usr/bin/env bun
// Render the bridge's fixed lines once with the local Kokoro TTS (claude-tts, :7802), so only
// Claude's answers go through Twilio's billed <Say>. Run again after changing LINES in lib.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LINES } from "./lib";

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
