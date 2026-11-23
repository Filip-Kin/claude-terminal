#!/usr/bin/env bun
// Simulated Twilio call against the local bridge: signed webhooks plus a media socket fed with
// Kokoro speech, so a call flow can be checked without a phone.
//   secret run twilio/auth-token=TWILIO_AUTH_TOKEN -- bun phone/sim.ts <from> <StirVerstat> <kokoro-voice> <utterance>...
// An utterance of "-" sends silence. The caller must be a user in config.json.
import { join } from "node:path";
import { loadConfig, twilioSignature } from "./lib";

const cfg = loadConfig(join(process.env.PHONE_STATE || "/var/lib/claude-phone", "config.json"));
const LOCAL = `http://127.0.0.1:${cfg.port}`, TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const [from, stir, voice, ...said] = process.argv.slice(2);
if (!TOKEN || !voice) { console.error("usage: see the header of phone/sim.ts"); process.exit(1); }
const sid = "CAsim" + crypto.randomUUID().replace(/-/g, "").slice(0, 27);

async function post(path: string, p: Record<string, string>): Promise<string> {
  const body = { CallSid: sid, From: from, ...p };
  const r = await fetch(LOCAL + path, { method: "POST", body: new URLSearchParams(body), headers: { "x-twilio-signature": twilioSignature(TOKEN, cfg.publicUrl + path, body) } });
  return (await r.text()).replace(/^.*<Response>/, "").replace("</Response>", "");
}

function mulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i]; const neg = s < 0; if (neg) s = -s;
    s = Math.min(s, 32635) + 0x84;
    let e = 7; for (let m = 0x4000; (s & m) === 0 && e > 0; m >>= 1) e--;
    out[i] = ~((neg ? 0x80 : 0) | (e << 4) | ((s >> (e + 3)) & 0x0f)) & 0xff;
  }
  return out;
}

async function speech(text: string): Promise<Uint8Array> {
  if (text === "-") return new Uint8Array(8000 * 2).fill(0xff); // 2 s of mu-law silence
  const r = await fetch("http://127.0.0.1:7802/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, speed: 1 }) });
  const wav = new Uint8Array(await r.arrayBuffer());
  const pcm24 = new Int16Array(wav.buffer.slice(44, 44 + ((wav.length - 44) & ~1)));
  const pcm8 = new Int16Array(Math.floor(pcm24.length / 3));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = (pcm24[3 * i] + pcm24[3 * i + 1] + pcm24[3 * i + 2]) / 3;
  return mulaw(pcm8);
}

const brief = (x: string) => x.replace(new RegExp(cfg.publicUrl + "/twilio/audio/", "g"), "").replace(/<Start>.*<\/Start>/, "[stream]").replace(/<Gather[^>]*>/g, "<Gather>").slice(0, 200);
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";

let x = await post("/twilio/voice", { StirVerstat: stir });
console.log(at(), "call  ->", brief(x));
const token = x.match(/name="token" value="([^"]+)"/)?.[1];
if (token) {
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/twilio/media`);
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ event: "start", start: { callSid: sid, customParameters: { token } } }));
  for (const text of said) {
    const audio = await speech(text);
    for (let i = 0; i < audio.length; i += 160) ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.from(audio.subarray(i, i + 160)).toString("base64") } }));
    await Bun.sleep(300);
    const h0 = Date.now();
    x = await post("/twilio/heard", { SpeechResult: text === "-" ? "" : text, Confidence: "0.9" });
    console.log(at(), "heard ->", brief(x));
    while (x.includes("<Redirect>/twilio/wait")) { await Bun.sleep(1000); x = await post("/twilio/wait", {}); }
    const answer = x.match(/<Say[^>]*>([\s\S]*?)<\/Say>/)?.[1];
    if (answer) console.log(at(), `answer after ${((Date.now() - h0) / 1000).toFixed(1)} s:`, answer.slice(0, 300));
    if (x.includes("<Hangup/>") && !x.includes("<Gather")) break;
  }
  ws.close();
}
await post("/twilio/status", { CallStatus: "completed" });
