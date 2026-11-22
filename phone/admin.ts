#!/usr/bin/env bun
// phone-admin: who may call, and voice enrolment.
//   phone-admin list
//   phone-admin add <user> <number>      number routes to that user's /app (guest port from guests.tsv)
//   phone-admin rm <user> [number]
//   phone-admin enroll <user> [label]    the next call from that user within 15 min records a voiceprint
//   phone-admin set <key> <json-value>   e.g. set from '"+12485550100"', set threshold 0.62
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, e164, type PhoneConfig, type PhoneUser } from "./lib";

const STATE = process.env.PHONE_STATE || "/var/lib/claude-phone";
const FILE = join(STATE, "config.json");
const GUESTS = process.env.GUESTS_TSV || "/home/filip/guest-claude/guests.tsv";
const OWNER = process.env.PHONE_OWNER || "filip";

const read = (): Partial<PhoneConfig> => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const write = (c: Partial<PhoneConfig>) => writeFileSync(FILE, JSON.stringify(c, null, 2) + "\n");

/** The owner's sidecar is 7682; a guest's is its ttyd port + 100 (add-guest.sh). */
function sidecarFor(user: string): string {
  if (user === OWNER) return "http://127.0.0.1:7682";
  const row = readFileSync(GUESTS, "utf8").split("\n").map((l) => l.split("\t")).find((r) => r[0] === user);
  if (!row) throw new Error(`no guest named ${user} in ${GUESTS}`);
  return `http://127.0.0.1:${Number(row[1]) + 100}`;
}

const [cmd, a, b] = process.argv.slice(2);
const cfg = read();
const users: PhoneUser[] = cfg.users ?? [];

if (cmd === "list") {
  for (const u of users) console.log(`${u.name}\t${u.numbers.join(",")}\t${u.sidecar}`);
  const prints = await fetch((cfg.speakerUrl ?? DEFAULTS.speakerUrl) + "/users").then((r) => r.json()).catch(() => null);
  console.log("voiceprints:", prints ? JSON.stringify(prints) : "speaker service not reachable");
} else if (cmd === "add" && a && b) {
  const n = e164(b);
  if (!n) throw new Error("not a phone number: " + b);
  const taken = users.find((u) => u.name !== a && u.numbers.includes(n));
  if (taken) throw new Error(`${n} already routes to ${taken.name}`);
  const u = users.find((x) => x.name === a);
  if (u) { if (!u.numbers.includes(n)) u.numbers.push(n); }
  else users.push({ name: a, numbers: [n], sidecar: sidecarFor(a) });
  write({ ...cfg, users });
  console.log(`${a}: ${n}. Restart claude-phone to load it.`);
} else if (cmd === "rm" && a) {
  const next = b ? users.map((u) => (u.name === a ? { ...u, numbers: u.numbers.filter((x) => x !== e164(b)) } : u)) : users.filter((u) => u.name !== a);
  write({ ...cfg, users: next.filter((u) => u.numbers.length) });
  console.log(`removed ${a}${b ? " " + e164(b) : ""}. Restart claude-phone to load it.`);
} else if (cmd === "enroll" && a) {
  if (!users.some((u) => u.name === a)) throw new Error(`${a} has no number; add one first`);
  mkdirSync(join(STATE, "enroll"), { recursive: true });
  writeFileSync(join(STATE, "enroll", a), `${Date.now() + 15 * 60_000}\t${b || "phone"}\n`);
  console.log(`${a}: the next call within 15 min enrols a voiceprint (label ${b || "phone"}).`);
} else if (cmd === "set" && a && b) {
  if (!(a in DEFAULTS) || a === "users") throw new Error("unknown key: " + a);
  write({ ...cfg, [a]: JSON.parse(b) });
  console.log(`${a} = ${b}. Restart claude-phone to load it.`);
} else {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 8).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd ? 1 : 0);
}
