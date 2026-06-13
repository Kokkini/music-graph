# 1h vs no-cache break-even (Opus 4.7)

## TL;DR

- **Turn 1**: no difference.
- **Turns 2–4**: 1h cache is *more expensive* than no cache (paying the $10/M write premium before reads compound).
- **Deepest deficit: end of turn 3** (−5.5 · K per million tokens).
- **Turn 5**: cumulative savings turn positive (first turn "in the black").
- **Turn 10+**: savings grow quadratically — by turn 10 you've saved ~136 · K per million tokens.
- **Practical rule**: if a session has ≥ 5 turns with gaps in the (5 min, 1 hr) window, enable 1h cache. Holds regardless of context size per turn — K only scales the magnitude.

(K = I + O = tokens added per turn. 5m cache with gaps > 5m is strictly worse than no cache, so the real comparison is 1h vs. off.)

---

## Pricing (Opus 4.7, $/M tokens)

| Base input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|
| 5 | 6.25 | 10 | 0.50 | 25 |

Cache write *replaces* base input — you don't pay both.

---

## Per-turn cost (input only; output O · $25/M is identical across strategies)

At turn t, the prompt has ≈ (t−1)·K + I input tokens.

**No cache:**
- input = [(t−1)K + I] · $5/M

**1h cache, warm** (cache extends by K each turn):
- read prior cache: (t−2)·K · $0.50/M
- write new K added by turn t−1: K · $10/M
- new user msg: I · $5/M

**Per-turn savings** Δ(t) = (no-cache input) − (1h input), dropping the shared I · $5:

Δ(t) = (t−1)K · 5 − [(t−2)K · 0.50 + K · 10]
     = K · [5(t−1) − 0.5(t−2) − 10]
     = **K · (4.5t − 14)**     [units: $/M]

Sign flips at t = 14 / 4.5 ≈ **3.11** → turn 4 is the first per-turn winner.

---

## Cumulative savings through turn T

S(T) = Σ_{t=2}^{T} Δ(t) = K · Σ_{t=2}^{T} (4.5t − 14)

Expand:

- Σ_{t=2}^{T} 4.5t = 4.5 · [T(T+1)/2 − 1]
- Σ_{t=2}^{T} 14   = 14(T − 1)

So:

S(T) / K = 4.5 · [T(T+1)/2 − 1] − 14(T − 1)
         = 2.25 T(T+1) − 4.5 − 14T + 14
         = **2.25 T² − 11.75 T + 9.5**

Solve = 0 (quadratic formula):

T = [11.75 ± √(11.75² − 4 · 2.25 · 9.5)] / (2 · 2.25)
  = [11.75 ± √(138.0625 − 85.5)] / 4.5
  = [11.75 ± √52.5625] / 4.5
  = [11.75 ± 7.25] / 4.5

Roots: T = 1.00 (trivial) and **T ≈ 4.22** (real break-even).

---

## Verification table (units: K · $/M)

| t  | Δ(t) = 4.5t − 14 | Cumulative S(t)/K |
|----|------------------|--------------------|
| 1  | 0                | 0                  |
| 2  | −5               | −5                 |
| 3  | −0.5             | −5.5  ← deepest deficit |
| 4  | +4               | −1.5  ← still red  |
| 5  | +8.5             | **+7**  ← first turn in black |
| 6  | +13              | +20                |
| 10 | +31              | +136               |

Crossover during turn 5, matching the quadratic root T ≈ 4.22.

---

## Why "5 turns" doesn't depend on K

K is a multiplier on the whole expression — it shifts dollar magnitudes but not the root. The break-even is determined entirely by the *rate ratios* ($5 base, $0.50 read, $10 write). Bigger turns just make the win bigger, not earlier.

## Caveats

- Assumes gaps stay under 1 hour. If gaps exceed 60 min, the 1h cache also dies and the 2× write premium is wasted.
- Claude Code CLI doesn't expose a TTL toggle; needs Agent SDK / direct API with `cache_control.ttl: "1h"`.
