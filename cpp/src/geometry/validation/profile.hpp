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
  // manufacturing decision, not inert metadata). Default 0.0 preserves the
  // sharp-fold assumption when a caller doesn't configure one.
  double defaultBendRadiusMm = 0.0;

  // ── Hole rules ──────────────────────────────────────────────────────────
  double minHoleDiameterFactor = 1.0;     // min diameter ≥ factor × thickness
  double minHoleToBendClearanceMm = 2.0;  // absolute mm — hole edge to hinge
  double minHoleToEdgeClearanceMm = 1.5;  // absolute mm — hole edge to outline
  double minHoleToHoleDistanceMm = 3.0;   // absolute mm — centre-to-centre

  // ── Flange rules ────────────────────────────────────────────────────────
  double minFlangeWidthFactor = 4.0;      // min flange ≥ factor × thickness
};

}  // namespace mcp_cad::validation
