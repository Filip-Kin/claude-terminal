// Per-model weights for "weighted output tokens" (shared by server.ts and ration.ts: one weighting).
export function makeModelWeight(overrides: Record<string, number> = {}) {
// "Weighted output tokens": each model's output tokens scaled by how much of the shared session
// limit that model actually costs, so a heavy-model user is billed for the load they put on the
// subscription rather than a flat per-token rate. These were API output prices relative to Sonnet 5
// until 2026-09-12, when 46 windows of subscription_samples were fit against model_usage
// (analysis/plan-capacity.py): per OUTPUT token, with Sonnet 5 = 1, the limit charges Opus ~1.6x
// (not the 2.5x its price implies) and Fable ~4.5x. Haiku stayed at its price-derived 0.5x: the
// measured 1.16x came from $189 of usage, which is noise. Sonnet 4.6 is unmeasured, still priced.
// Overridable via cfg.modelWeights.
  const MODEL_WEIGHTS: Record<string, number> = Object.assign({
  "claude-opus-5": 1.6, "claude-opus-4-8": 1.6, "claude-opus-4-7": 1.6, "claude-opus-4-6": 1.6,
  "claude-sonnet-5": 1.0, "claude-sonnet-4-6": 1.5, "claude-sonnet-4-5": 1.5,
  "claude-haiku-4-5": 0.5, "claude-haiku-4-5-20251001": 0.5,
  "claude-fable-5-1": 4.5, "claude-fable-5": 4.5,
  // Unmeasured: the family weight.
  "claude-fable-5-2": 4.5, "claude-opus-5-5": 1.6, "claude-sonnet-5-5": 1.0, "claude-haiku-5-5": 0.5,
}, overrides);
// A model the map does not know is weighted 1.0 (treated as a Sonnet-class token) rather than
// dropped, so a new model still counts toward the bill until its weight is added.
  const modelWeight = (m: string) => MODEL_WEIGHTS[m] ?? MODEL_WEIGHTS[String(m).replace(/-\d{8}$/, "")] ?? 1.0;

  return { MODEL_WEIGHTS, modelWeight };
}
