# 17 — Numerical Policy Module Spec (Phase 2.4, cont'd)

**Status:** Reviewed & approved by Paul 2026-07-20. §7's two open points are **not**
resolved by this approval — they remain open, deferred (17.1 to a future usage
decision, 17.2 to archaeology/first-principles derivation once a stack exists to
profile against); neither blocks the module's structure or enforcement discipline.
**Inputs it must satisfy:** 04 P4 (central numerical policy, its own enforcement
mechanism), 02 N3 (the requirement) and N11 (project tolerance profiles — the thing
this module is explicitly *not*), 12-domain-notes §2 (the raw v1 facts this
consolidates), 13 §10 D5 (doubles, profile-relative comparisons, no epsilon literals
inside the module), 16 (the kernel port this module supplies constants to).

---

## 0. The one rule that resolves most confusion: two kinds of "tolerance"

This module and N11 (project tolerance profiles) both hand out numbers that look like
tolerances, and keeping them straight is the entire point of this doc:

| | **N11 profile** | **This module (policy)** |
|---|---|---|
| Answers | "Is this *result* good enough?" | "Are these two numbers the *same value*, allowing for floating-point/kernel noise?" |
| Varies by | Project (loose/default/tight, N11) | Never — fixed, one value, forever |
| Example | Mapping round-trip budget: 0.1 mm (default), configurable | Collinearity epsilon: a fixed constant no project ever changes |
| Who sets it | The project/user, via a named profile | This module, once, with a documented reason (P4) |

**The test, in one sentence:** if a *manufacturer* could reasonably want a different
number here, it's N11. If changing the number would only ever paper over numerical
noise or break geometric correctness, it's this module. Boolean fuzz (§2) is the
clearest example: a project with a *looser* manufacturing tolerance does not want a
*looser* boolean fuzz — that risks silently breaking geometry (12-domain-notes §2's
0.15 mm bug) — it wants exact computation always, with N11's budget applied
separately, on top, to the *result*.

## 1. Units and representation

- **Canonical units at every module boundary and in storage:** millimetres for
  length, degrees for angle (13 §10 D5, matches 14's schema throughout). No module
  stores or exchanges radians, inches, or any other unit across a boundary.
- **Internal trigonometric computation may use radians locally** (most math
  libraries want them) — but must convert at entry and exit. A radian value never
  crosses a function boundary named in 13/14/15/16.
- **Representation:** doubles (13 §10 D5 — decided). No arbitrary-precision or fixed-
  point representation; correctness comes from the policy below, not the number type.

## 2. Fixed constants (never profile-configurable)

Carried forward from v1's evidence (12-domain-notes §2), each with the reason it's
fixed rather than tunable:

| Constant | Value | Why it's fixed, not N11 |
|---|---|---|
| `WINDING` | CCW (shoelace sign) for outlines, CW for holes | A convention, not a measurement — there's no "looser" or "tighter" winding (12-domain-notes §2; 14 §5). |
| `BOOLEAN_FUZZ_MM` | `1e-3` | Kernel-internal noise floor (Port C/D, 16). The v1 bug (0.15 mm silently discarding ~50% of volume once kerf detail existed) is exactly what happens when this is treated as tunable. **Scales with the smallest feature present, not part size** — see §2.1. Fixed at 1e-3 mm (1 micron), not 1e-5: resolution is meaningful only relative to the project's working unit, and this project works in millimetres (metres are impractical for sheet-metal-scale parts) — 1e-3 mm is the floor's real value under that unit choice, not an arbitrary loosening. |
| `COLLINEARITY_EPSILON` | fixed, small (cross-product-based) | Used by the region-clipping algorithm (14 §2.1/OPEN-D2.6) to detect degenerate/near-zero-area slivers. Purely a numerical-robustness constant. |
| `ZERO_LENGTH_EPSILON_MM` | fixed, small | Detects degenerate edges/hinges during import reconciliation (13 §6) and outline editing (K2). |
| `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` | ~2 mm (v1 evidence) | The adjacency gate for "close enough to share a bend edge" during `merge_bodies_with_bend` (14 §2.1.2). Stays fixed — `OPEN-17.1` resolved (§7): this is genuinely an import-noise floor, not a judgment call, once it isn't also asked to decide which of two rigid-transform hypotheses is true (that's a different, tighter, `kCoplanarLinearToleranceMm`-class decision — see `step_reconciliation.cc`'s `kSelfConsistencyToleranceMm`, rebuild/20-bend-bridge-geometry.md Ch. 6d). |

### 2.1 Why boolean fuzz is a *relative*, not absolute, constant

`BOOLEAN_FUZZ_MM` is not literally "always exactly 1e-3 mm regardless of geometry" —
v1's own lesson (12-domain-notes §2) was that a fixed-too-coarse value silently ate
real feature detail. The policy: fuzz tolerance is derived as
`min(1e-3, smallestFeatureDimension × relativeFactor)` — i.e., it never exceeds a
small absolute ceiling, but shrinks further when the geometry itself contains
features smaller than that ceiling (a kerf notch, a small hole near a boolean seam).
This is a *numerical robustness* rule (how do we avoid destroying real detail), not a
manufacturing-accuracy one — still not N11's concern.

## 3. Comparison helpers (the only sanctioned way to compare numbers)

The policy module exposes a small, named set of comparison functions — conceptually,
not as language bindings:

- `nearlyEqual(a, b)` — using the fixed epsilon appropriate to the value's kind
  (length vs. angle have different fixed epsilons; the module dispatches, callers
  never pick).
- `isZeroLength(vector)`, `isCollinear(p1, p2, p3)` — degeneracy detection for the
  region-clipping algorithm (14 §2.1) and outline editing (K2).
- `canonicalWinding(ring)` — returns a CCW-canonicalized ring; the *only* place
  winding canonicalization happens (12-domain-notes §2's "any kernel adapter must
  canonicalize at the boundary" — this is that canonicalization, named and singular).
- `withinProfile(value, budgetKey, profile)` — the bridge to N11: the *one* function
  that reads a project tolerance profile at all. Everything in §2 above never calls
  this; everything checking a *result* against a manufacturing budget always does.

**No inline tolerance literals anywhere else (N3, P4's enforcement).** A number that
looks like a tolerance, appearing outside this module, is a lint failure once Phase 4
tooling exists — not a style preference.

## 4. Degeneracy is reported, never silently repaired

Consistent with N5 (no silent fallbacks) and P3: when a comparison helper detects a
degenerate case (a near-zero-length edge, a near-collinear triple, a region-clip
producing a sliver below `COLLINEARITY_EPSILON`), **the module returns a
classification, never a "fixed" value.** It does not snap points together, does not
drop the offending vertex, does not round an angle to the nearest degree. The caller
(13's algorithms, a graph-CRUD verb) decides what typed error or finding (15 §2) to
raise. This is the same discipline L1/L3 already established for geometry; this
module is where it's enforced for arithmetic specifically.

## 5. Relationship to the kernel port (16)

`BOOLEAN_FUZZ_MM` (and its relative variant, §2.1) is supplied *by this module* to
Port C and Port D's adapters (16 §1) — the kernel-fuzz decision lives in exactly one
place, never re-chosen per call site. `WINDING`'s canonicalization is what Port B's
measured boundaries pass through before 13 ever sees them (12-domain-notes §2,
13 §6). Any future kernel adapter is a *consumer* of this module's constants, never a
second source for them.

## 6. Enforcement (P4, restated concretely)

- **Lint:** a boundary/pattern check (Phase 4 tooling) bans numeric literals that
  look like tolerances (a bare small float compared against a computed value)
  anywhere outside this module's own file(s). Allowlist is exactly one module.
- **Property tests:** `canonicalWinding` is idempotent and always produces CCW for
  outlines/CW for holes across randomly generated polygons (13 §8-style property
  test, extended to this module specifically).
- **Code review checklist item** (P4): any PR introducing a new comparison must use
  an existing helper or add one *here*, never inline a new epsilon at the call site.

## 7. Open points

- `[OPEN-17.1]` **Resolved.** `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (~2 mm) originally
  looked like a judgment call because `step_reconciliation.cc`'s own mirror of it,
  `kSelfConsistencyToleranceMm`, was sharing the exact same 2 mm value for a *different*
  question: not "are these two edges close enough to be the same seam" (genuine
  import-noise robustness — this constant's real job) but "which of two candidate
  rigid-transform hypotheses (concave vs. convex pivot) actually matches this piece's
  measured position" (a geometric-fact decision, which needs a tighter, precedented
  tolerance — see `kCoplanarLinearToleranceMm`, 0.1mm). Conflating the two made the
  geometric-fact decision impossible to get right for realistic material thickness
  (derivation + fix: `rebuild/20-bend-bridge-geometry.md` Ch. 6d). Once split, this
  constant is exactly what its name says — an import-noise floor — and stays fixed, not
  moved into the tolerance profile. The general lesson: a tolerance shared between an
  adjacency/robustness check and a which-hypothesis-is-true check is a smell, not a
  convenience — split them before concluding either one needs to be tunable.
- `[OPEN-17.2]` Exact numeric values for `COLLINEARITY_EPSILON` and
  `ZERO_LENGTH_EPSILON_MM` are named but not pinned to a specific number in this
  doc — v1 evidence didn't surface explicit values for these the way it did for
  boolean fuzz. Needs either archaeology (check v1 source for any implicit constants)
  or a first-principles derivation once a stack/kernel exists to profile against.
