#pragma once

/**
 * validation/profile.hpp — ManufacturingProfile, the threshold set every rule
 * reads.
 *
 * Each factor is × thicknessMm unless marked as absolute mm.  Sensible defaults
 * are provided — the TS side can override any field via the NAPI binding.
 *
 * Per AC-F.2 (rebuild/11-acceptance-criteria.md): changing the profile changes
 * the finding outcome for a boundary-straddling fixture.
 */

#include <string>

namespace mcp_cad::validation {

struct ManufacturingProfile {
  std::string profileId;
  std::string name;

  // ── Bend rules ──────────────────────────────────────────────────────────
  double minBendRadiusFactor = 1.0;       // min radius ≥ factor × thickness
  double maxBendAngleDeg = 180.0;         // angle must be in [0, max]

  // Absolute mm, not a thickness factor — real tooling has a roughly fixed
  // inside bend radius that doesn't scale with every part's own thickness.
  // Used by translation::ReconcilePieces as the assumed radius stamped
  // onto every bend import_part reconciles (no radius is directly
  // measurable from a flat-panel decomposition — see
  // step_reconciliation.hpp's own header comment for why stamping it in is
  // safe: Evaluate() re-derives the flat/3D representation fresh from
  // whatever radius a bend carries, so this is a real, effective
  // manufacturing decision, not inert metadata).
  //
  // -1.0 is the sentinel for "the caller never configured this" — NOT a
  // real radius. A caller that explicitly wants a sharp fold passes 0.0
  // literally; ReconcilePieces treats that as a genuine request (0.0 is a
  // valid double coming over the NAPI boundary exactly like any other
  // value) and does NOT substitute thicknessMm for it. Only the -1.0
  // sentinel — which a real radius can never be — triggers the
  // thicknessMm fallback (docs/BUG_REPORT_import_bend_radius_always_
  // zero_or_thickness.md's 2026-09-14 correction).
  double defaultBendRadiusMm = -1.0;

  // ── Hole rules ──────────────────────────────────────────────────────────
  double minHoleDiameterFactor = 1.0;     // min diameter ≥ factor × thickness
  double minHoleToBendClearanceMm = 2.0;  // absolute mm — hole edge to hinge
  double minHoleToEdgeClearanceMm = 1.5;  // absolute mm — hole edge to outline
  double minHoleToHoleDistanceMm = 3.0;   // absolute mm — centre-to-centre

  // ── Flange rules ────────────────────────────────────────────────────────
  double minFlangeWidthFactor = 4.0;      // min flange ≥ factor × thickness
};

}  // namespace mcp_cad::validation
