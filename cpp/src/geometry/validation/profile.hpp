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
  // NOT used for geometry construction and NOT stamped onto any bend's
  // radiusMm (that was tried 2026-08-03 and reverted 2026-08-06 — see
  // docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md; a
  // flat-panel decomposition can't measure a real radius, and silently
  // assuming one moved reconstructed geometry away from the true part).
  // Used only as the suggested value in validation/rules/bend_radius.cc's
  // BEND_RADIUS_NOT_MEASURED finding, for bends reconciliation produced
  // (BendSpec::radiusMeasured == false) — a caller confirms it via
  // update_node, which is what actually changes geometry.
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
