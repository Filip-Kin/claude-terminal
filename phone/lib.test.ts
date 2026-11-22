import { describe, expect, test } from "bun:test";
import { admit, DEFAULTS, e164, gather, isGoodbye, linkNumber, sidecarFor, signatureOk, spoken, startStream, twilioSignature, userForCaller, voiceVerdict, type PhoneConfig } from "./lib";

const cfg: PhoneConfig = {
  ...DEFAULTS, from: "+15550001111",
  users: [
    { name: "filip", numbers: ["+12485550100"], sidecar: "http://127.0.0.1:7682" },
    { name: "ian", numbers: ["+1 (313) 555-0199"], sidecar: "http://127.0.0.1:7783" },
  ],
};

describe("caller routing", () => {
  test("each number reaches its own user's sidecar", () => {
    expect(userForCaller(cfg, "+12485550100")?.sidecar).toBe("http://127.0.0.1:7682");
    expect(userForCaller(cfg, "+13135550199")?.name).toBe("ian");
    expect(userForCaller(cfg, "+13135550199")?.sidecar).toBe("http://127.0.0.1:7783");
  });
  test("an unknown, withheld or empty caller id reaches nobody", () => {
    for (const from of ["+19995550123", "anonymous", "", "+", "Restricted"]) expect(userForCaller(cfg, from)).toBeNull();
  });
  test("number formats normalise", () => {
    expect(e164("(248) 555-0100")).toBe("+12485550100");
    expect(e164("+44 20 7946 0958")).toBe("+442079460958");
    expect(e164("anonymous")).toBe("");
  });
});

describe("admission", () => {
  test("a known number with full attestation is admitted as that user", () => {
    const a = admit(cfg, "+12485550100", "TN-Validation-Passed-A");
    expect(a.ok && a.user.name).toBe("filip");
  });
  // The bug this guards: caller id alone is spoofable, so the owner's number without the carrier's
  // full attestation must never open a chat.
  test("the owner's number with weak, failed or missing attestation is refused", () => {
    for (const stir of ["TN-Validation-Passed-B", "TN-Validation-Passed-C", "TN-Validation-Failed-A", "No-TN-Validation", "NULL", "-", ""]) {
      expect(admit(cfg, "+12485550100", stir)).toEqual({ ok: false, why: "attestation" });
    }
  });
  test("an unknown caller is refused whatever its attestation", () => {
    expect(admit(cfg, "+19995550123", "TN-Validation-Passed-A")).toEqual({ ok: false, why: "unknown-caller" });
  });
});

describe("voice verdict", () => {
  test("no voiceprint never passes", () => expect(voiceVerdict(cfg, { enrolled: false, score: 0.99, speechMs: 5000 })).toBe("not-enrolled"));
  test("too little speech is short, not a pass", () => {
    expect(voiceVerdict(cfg, { enrolled: true, score: 0.99, speechMs: cfg.minSpeechMs - 1 })).toBe("short");
    expect(voiceVerdict(cfg, { enrolled: true, score: null, speechMs: 5000 })).toBe("short");
  });
  test("the threshold decides", () => {
    expect(voiceVerdict(cfg, { enrolled: true, score: cfg.threshold, speechMs: 3000 })).toBe("pass");
    expect(voiceVerdict(cfg, { enrolled: true, score: cfg.threshold - 0.01, speechMs: 3000 })).toBe("fail");
  });
});

describe("twilio", () => {
  // Reference vector from Twilio's request-validation documentation.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  test("signature matches Twilio's documented example", () => {
    expect(twilioSignature("12345", url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(signatureOk("12345", url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
  });
  test("a changed parameter, url or missing header fails", () => {
    expect(signatureOk("12345", url, { ...params, From: "+12485550100" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    expect(signatureOk("12345", url + "x", params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    expect(signatureOk("12345", url, params, "")).toBe(false);
  });
  test("gather and stream markup", () => {
    expect(gather(cfg)).toContain('speechTimeout="1"');
    expect(gather(cfg)).toContain('actionOnEmptyResult="true"');
    expect(startStream(cfg, "tok")).toBe('<Start><Stream url="wss://call.filipkin.com/twilio/media" track="inbound_track"><Parameter name="token" value="tok"/></Stream></Start>');
  });
});

describe("spoken text", () => {
  test("strips title, code, links and markdown", () => {
    expect(spoken("<title>Fantasy</title>**You lead** by 12. See [the board](https://x.y/z) or https://a.b\n```ts\nconst a=1\n```", 1500))
      .toBe("You lead by 12. See the board or a link in the app (code is in the app)");
  });
  test("cuts at the limit on a word", () => expect(spoken("one two three four", 9)).toBe("one two. The rest is in the app."));
  test("empty becomes a pointer to the app", () => expect(spoken("```x```".replace("x", ""), 100)).toContain("app"));
  test("goodbye words end the call", () => {
    expect(isGoodbye("No thanks.")).toBe(true);
    expect(isGoodbye("no, check the garage")).toBe(false);
  });
});

describe("self-setup", () => {
  test("a user links one number and it replaces their earlier one", () => {
    const r = linkNumber(cfg, "ian", "http://127.0.0.1:7783", "(313) 555-0142");
    expect(r.ok && r.users.find((u) => u.name === "ian")?.numbers).toEqual(["+13135550142"]);
    expect(r.ok && r.users.length).toBe(2);
  });
  // The guard: a guest must never route another user's number (or the owner's) to their own chat.
  test("a number that belongs to someone else is refused", () => {
    expect(linkNumber(cfg, "ian", "http://127.0.0.1:7783", "+1 248 555 0100")).toEqual({ ok: false, why: "in-use" });
    expect(linkNumber(cfg, "zach", "http://127.0.0.1:7787", "3135550199")).toEqual({ ok: false, why: "in-use" });
  });
  test("the Claude line itself and junk are refused", () => {
    expect(linkNumber(cfg, "ian", "x", "+15550001111")).toEqual({ ok: false, why: "own-number" });
    expect(linkNumber(cfg, "ian", "x", "hello")).toEqual({ ok: false, why: "not-a-number" });
  });
  test("sidecar lookup: owner, guest by tsv port + 100, unknown user", async () => {
    const tsv = "/tmp/phone-test-guests.tsv";
    await Bun.write(tsv, "ian\t7683\nmichel\t7685\n");
    expect(sidecarFor("filip", "filip", tsv)).toBe("http://127.0.0.1:7682");
    expect(sidecarFor("michel", "filip", tsv)).toBe("http://127.0.0.1:7785");
    expect(sidecarFor("mallory", "filip", tsv)).toBeNull();
  });
});
