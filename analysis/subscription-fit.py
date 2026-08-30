#!/usr/bin/env python3
"""Fit the claude.ai subscription session limit against measured token use.

    python3 analysis/subscription-fit.py [/var/lib/claude-terminal/usage.db]

Reads subscription_samples (the sampled 5h/7d utilisation) and model_usage (the per-minute,
per-model token split) and answers two questions:

  1. which token types the limit actually charges for, and at what relative weight
  2. whether model mix explains anything once those weights are in

Method: pool every sample in every complete 5h window, subtract each window's own baseline,
and least-squares fit

    util(t) - util(t0)  =  sum_j  c_j * ( tokens_j(t) - tokens_j(t0) )

Only stdlib, so it runs anywhere the collector does. Read-only on the database.

Result as at 2026-08-30, 7 windows / 44 hours of samples: output alone leaves 7.25pp RMS
error; output + cache_creation cuts it to 4.95pp, with a cache-creation token costing roughly
a fourteenth of an output token. Model mix (opus 4.8 vs opus 5) barely moved it, and the haiku
weight was fitting noise at under 1% of output. Re-run as windows accrue.
"""
import sqlite3
import sys
import datetime
import itertools

DB = sys.argv[1] if len(sys.argv) > 1 else "/var/lib/claude-terminal/usage.db"
KINDS = ["input", "output", "cache_creation", "cache_read"]
MIN_SAMPLES_PER_WINDOW = 20
# resets_at is recomputed per response and jitters about a second, so samples within this
# distance of each other belong to the same real window.
WINDOW_TOLERANCE_S = 600


def parse_iso(s):
    return datetime.datetime.fromisoformat(s).timestamp()


def parse_minute(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(
        tzinfo=datetime.timezone.utc).timestamp()


def load_windows(db):
    rows = db.execute(
        "select ts, five_hour_util, five_hour_reset from subscription_samples "
        "where five_hour_reset is not null order by ts").fetchall()
    wins = []
    for ts, util, reset in rows:
        rt = parse_iso(reset)
        if wins and abs(rt - wins[-1]["reset"]) < WINDOW_TOLERANCE_S:
            wins[-1]["pts"].append((ts / 1000.0, util))
            wins[-1]["reset"] = rt
        else:
            wins.append({"reset": rt, "pts": [(ts / 1000.0, util)]})
    return [w for w in wins if len(w["pts"]) >= MIN_SAMPLES_PER_WINDOW]


def build_design(db, wins, group_by_model=False):
    """Rows of cumulative-within-window token counts, paired with utilisation consumed."""
    if group_by_model:
        cols = [r[0] for r in db.execute(
            "select model, sum(output) from model_usage group by model "
            "order by sum(output) desc").fetchall()]
        raw = db.execute(
            "select minute_utc, model, sum(output) from model_usage group by 1,2").fetchall()
        buckets = sorted((parse_minute(m), cols.index(mod), out) for m, mod, out in raw)
    else:
        cols = KINDS
        raw = db.execute(
            "select minute_utc, sum(input), sum(output), sum(cache_creation), sum(cache_read) "
            "from model_usage group by 1").fetchall()
        buckets = sorted((parse_minute(r[0]), r[1:]) for r in raw)

    X, y, per_window = [], [], []
    for w in wins:
        t0, u0 = w["pts"][0]
        run = [0.0] * len(cols)
        bi = 0
        while bi < len(buckets) and buckets[bi][0] < t0:
            bi += 1
        for t, util in w["pts"]:
            while bi < len(buckets) and buckets[bi][0] <= t:
                if group_by_model:
                    run[buckets[bi][1]] += buckets[bi][2]
                else:
                    for j in range(len(cols)):
                        run[j] += buckets[bi][1][j]
                bi += 1
            if sum(run) > 0:
                X.append(list(run))
                y.append(util - u0)
        per_window.append((datetime.datetime.utcfromtimestamp(w["reset"]).strftime("%m-%d %H:%M"),
                           w["pts"][-1][1] - u0, list(run)))
    return cols, X, y, per_window


def solve(A, b):
    """Least squares via normal equations with Gauss-Jordan. None if singular."""
    k = len(A[0])
    M = [[sum(A[r][i] * A[r][j] for r in range(len(A))) for j in range(k)]
         + [sum(A[r][i] * b[r] for r in range(len(A)))] for i in range(k)]
    for i in range(k):
        p = max(range(i, k), key=lambda r: abs(M[r][i]))
        if abs(M[p][i]) < 1e-9:
            return None
        M[i], M[p] = M[p], M[i]
        for r in range(k):
            if r == i:
                continue
            f = M[r][i] / M[i][i]
            for c in range(i, k + 1):
                M[r][c] -= f * M[i][c]
    return [M[i][k] / M[i][i] for i in range(k)]


def rms(X, y, cols_idx, w):
    s = 0.0
    for row, target in zip(X, y):
        pred = sum(w[a] * row[c] for a, c in enumerate(cols_idx))
        s += (pred - target) ** 2
    return (s / len(y)) ** 0.5


def main():
    db = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    have = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    if "model_usage" not in have:
        sys.exit("model_usage not found: run the collector at least once first")

    wins = load_windows(db)
    if not wins:
        sys.exit("no complete 5h windows sampled yet")

    kinds, X, y, per_window = build_design(db, wins)
    print(f"{len(wins)} complete 5h windows, {len(X)} pooled samples")
    print(f"RMS of the utilisation deltas themselves: "
          f"{(sum(t*t for t in y)/len(y))**0.5:.2f} pp\n")

    print("WHICH TOKEN TYPES THE LIMIT CHARGES FOR")
    print(f"{'columns':42} {'RMS pp':>7}  weights, % of the 5h window per Mtok")
    results = []
    for k in range(1, len(kinds) + 1):
        for idx in itertools.combinations(range(len(kinds)), k):
            A = [[row[c] for c in idx] for row in X]
            w = solve(A, y)
            if w:
                results.append((rms(X, y, idx, w), idx, w))
    for err, idx, w in sorted(results)[:6]:
        name = "+".join(kinds[c] for c in idx)
        ws = "  ".join(f"{kinds[c]}={1e6*wi:.2f}" for c, wi in zip(idx, w))
        flag = "   <- negative weight, not physical" if any(x < 0 for x in w) else ""
        print(f"{name:42} {err:7.2f}  {ws}{flag}")

    positive = [r for r in sorted(results) if all(x >= 0 for x in r[2])]
    if positive:
        err, idx, w = positive[0]
        print(f"\nbest all-positive combination: {'+'.join(kinds[c] for c in idx)}  "
              f"RMS {err:.2f} pp")
        for c, wi in zip(idx, w):
            print(f"  {kinds[c]:16} {1e6*wi:9.3f} %/Mtok  ->  {1/wi/1e3:12,.0f}k tokens per 1%")
        ref = max(w)
        print("  relative cost per token: " + ", ".join(
            f"{kinds[c]} {wi/ref:.3f}x" for c, wi in zip(idx, w)))

    print("\nDOES MODEL MIX ADD ANYTHING (output tokens only)")
    models, XM, yM, pw = build_design(db, wins, group_by_model=True)
    flat_w = (sum(sum(r) * t for r, t in zip(XM, yM))
              / sum(sum(r) ** 2 for r in XM))
    flat_err = (sum((sum(r) * flat_w - t) ** 2 for r, t in zip(XM, yM)) / len(yM)) ** 0.5
    print(f"  flat, one weight for all output:  RMS {flat_err:.2f} pp"
          f"   ({1/flat_w/1e3:,.0f}k output tokens per 1%)")
    wm = solve(XM, yM)
    if not wm:
        print("  per-model fit is singular: at least one model has no output inside any sampled")
        print("  window, so its weight is unidentifiable. Needs more windows.")
    if wm:
        err = (sum((sum(a*b for a, b in zip(r, wm)) - t) ** 2
                   for r, t in zip(XM, yM)) / len(yM)) ** 0.5
        print(f"  per-model weights:                RMS {err:.2f} pp")
        total = sum(sum(r[i] for r in XM) for i in range(len(models)))
        for i, m in enumerate(models):
            share = sum(r[i] for r in XM) / total if total else 0
            note = "  (share too small to trust)" if share < 0.02 else ""
            print(f"    {m:30} {1e6*wm[i]:8.2f} %/Mtok  {share:6.1%} of output{note}")

    print("\nPER WINDOW, utilisation consumed vs predicted")
    print(f"{'window':16} {'actual':>7} {'predicted':>10}")
    if positive:
        _, idx, w = positive[0]
        for name, du, run in per_window:
            pred = sum(w[a] * run[c] for a, c in enumerate(idx))
            print(f"{name:16} {du:7.0f} {pred:10.1f}")


if __name__ == "__main__":
    main()
