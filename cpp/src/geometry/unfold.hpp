#pragma once

/**
 * Sheet metal unfolding interface.
 *
 * Unfolding projects a 3-D shell into a flat 2-D representation, compensating
 * for material stretching via the K-factor (neutral axis offset ratio).
 *
 * Output is a 2-D wire geometry — the flattened blank outline — together with
 * the flat dimensions required for DXF export and nesting.
 *
 * K-factor reference:
 *   bend_allowance = (π/180) × angle × (radius + k × thickness)
 *
 * Default K-factor: 0.33 (mild steel, air-bend, empirically determined).
 * Valid range: [0.25, 0.50].
 *
 * Task: T069
 */

#include <string>

namespace mcp_cad {

// Flat blank dimensions produced by the unfold algorithm.
struct FlatBlank {
  double widthMm   = 0.0;
  double heightMm  = 0.0;
  int    bendCount = 0;
  double kFactorUsed = 0.33;
};

}  // namespace mcp_cad
