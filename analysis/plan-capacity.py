#!/usr/bin/env python3
"""Compare the size of the session (5h) and weekly (7d) limits ACROSS a plan change.

    uv run --with numpy --with scipy analysis/plan-capacity.py [usage.db]

Sibling of subscription-fit.py, which asks what the limit charges for. This one asks how big
the bucket is, and how that changed when the subscription changed on 2026-09-01.

Method: per limit window, take the utilisation increment (running max of a median-3 filtered
series, so one bad sample cannot double-count) and the token use logged in the same span,
converted to API-list-price dollars per model. NNLS gives dollars-per-utilisation-point per
model on the current plan; those weights then normalise the old plan's different model mix,
so the two eras are compared at a matched mix rather than at face value.

Data traps that cost the first two passes:
  * subscription_samples rows where the SDK returned nothing carry util 0 with NULL windows.
    Kept, they read as a reset and invent ~70 points of fake increments. Drop NULL-window rows.
  * per_model_output/per_model_total in the snapshot were still being backfilled through
    2026-09-01, so those columns disagree with cum_output by 3x in that period. Take per-model
    tokens from the model_usage table, which the backfill corrected retroactively.
  * a 5h window pinned at 100% still burns tokens that can no longer raise the number. Exclude
    segments above the ceiling or the older, smaller plan looks bigger than it was.
"""
import sqlite3, sys, json, datetime as dt
from collections import defaultdict
import numpy as np
from scipy.optimize import nnls

DB = sys.argv[1] if len(sys.argv) > 1 else "/var/lib/claude-terminal/usage.db"
SWITCH = dt.datetime(2026, 9, 1, 17, 0, tzinfo=dt.UTC).timestamp() * 1000
CEILING = 95.0          # ignore utilisation above this: the window is saturated
MODELS = ["claude-opus-4-8", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5",
          "claude-haiku-4-5-20251001"]
# $/MTok: input, output, cache read, cache write (5m)
PRICE = {"claude-fable-5-1": (10, 50, 0.25, 12.5), "claude-opus-5": (5, 25, 0.5, 6.25),
         "claude-opus-4-8": (5, 25, 0.5, 6.25), "claude-sonnet-5": (2, 10, 0.2, 2.5),
         "claude-sonnet-4-6": (3, 15, 0.3, 3.75), "claude-haiku-4-5-20251001": (1, 5, 0.1, 1.25)}

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

def usd(model, tok):
    i, o, cw, cr = tok
    p = PRICE.get(model, PRICE["claude-opus-5"])
    return (i * p[0] + o * p[1] + cr * p[2] + cw * p[3]) / 1e6

minutes = defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))
for r in con.execute("select minute_utc,model,input,output,cache_creation,cache_read from model_usage"):
    a = minutes[r[0]][r[1]]
    for i, v in enumerate(r[2:]):
        a[i] += v

def tokens_between(a, b):
    out = defaultdict(lambda: [0, 0, 0, 0])
    t = dt.datetime.fromtimestamp(a / 1000, dt.UTC).replace(second=0, microsecond=0)
    end = dt.datetime.fromtimestamp(b / 1000, dt.UTC)
    while t <= end:
        for m, v in minutes.get(t.strftime("%Y-%m-%dT%H:%M"), {}).items():
            for i in range(4):
                out[m][i] += v[i]
        t += dt.timedelta(minutes=1)
    return out

rows = [dict(r) for r in con.execute(
    "select ts,five_hour_util,five_hour_window,seven_day_util,seven_day_window "
    "from subscription_samples order by ts")]
rows = [r for r in rows if r["five_hour_window"] and r["seven_day_window"]]   # drop SDK blanks

def median3(v):
    out = list(v)
    for i in range(1, len(v) - 1):
        out[i] = sorted(v[i - 1:i + 2])[1]
    return out

def segments(kind):
    col, wcol = (("five_hour_util", "five_hour_window") if kind == "5h"
                 else ("seven_day_util", "seven_day_window"))
    groups = defaultdict(list)
    for r in rows:
        groups[(r[wcol], "old" if r["ts"] < SWITCH else "new")].append(r)
    segs = []
    for (_, era), rs in groups.items():
        if len(rs) < 3:
            continue
        u = median3([r[col] for r in rs])
        if any(x is None for x in u):
            continue
        run = np.maximum.accumulate(u)
        dutil, spans = 0.0, []
        for i in range(1, len(rs)):
            if 0 < rs[i]["ts"] - rs[i - 1]["ts"] <= 240000 and run[i - 1] < CEILING:
                dutil += max(0.0, min(run[i], CEILING) - run[i - 1])
                spans.append((rs[i - 1]["ts"], rs[i]["ts"]))
        if dutil < 2:
            continue
        tok = defaultdict(lambda: [0, 0, 0, 0])
        for a, b in spans:
            for m, v in tokens_between(a, b).items():
                for i in range(4):
                    tok[m][i] += v[i]
        segs.append({"era": era, "dutil": dutil, "tok": tok,
                     "cost": {m: usd(m, v) for m, v in tok.items()}})
    return segs

def matrix(segs, field):
    return np.array([[s["cost"].get(m, 0) if field == "cost" else s["tok"].get(m, [0] * 4)[field]
                      for m in MODELS] for s in segs])

s5, s7 = segments("5h"), segments("7d")
new5 = [s for s in s5 if s["era"] == "new"]
old5 = [s for s in s5 if s["era"] == "old"]
yN = np.array([s["dutil"] for s in new5])
weights, _ = nnls(matrix(new5, "cost"), yN)          # utilisation points per API dollar, per model

print(f"{len(new5)} new-plan windows, {len(old5)} old-plan windows\n")
print("current plan, one full 5h session spent entirely on one model:")
wout, _ = nnls(matrix(new5, 1), yN)
for i, m in enumerate(MODELS):
    print(f"  {m:28s} ${100/weights[i]:7.0f} api-equivalent | {100/wout[i]/1e6:5.1f}M output tokens")

for label, segs in (("5h session", (old5, new5)), ("7d weekly", ([s for s in s7 if s["era"] == "old"],
                                                                 [s for s in s7 if s["era"] == "new"]))):
    old, new = segs
    def rate(sel):
        x = matrix(sel, "cost") @ weights
        y = np.array([s["dutil"] for s in sel])
        return x, y, float((x @ y) / (x @ x))
    xo, yo, ko = rate(old)
    xn, yn, kn = rate(new)
    rng = np.random.default_rng(7)
    bs = [float((xo[i] @ yo[i]) / (xo[i] @ xo[i])) / kn
          for i in (rng.integers(0, len(yo), len(yo)) for _ in range(5000))]
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f"\n{label}: new plan holds {ko/kn:.2f}x the old one (95% CI {lo:.2f}-{hi:.2f})")
