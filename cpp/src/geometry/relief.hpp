#pragma once

/**
 * Corner relief generation interface.
 *
 * Reliefs are small cutouts added to internal bend-line intersections to prevent
 * material tearing and cracking during sheet metal forming. Two standard types
 * are supported by the MVP:
 *
 *   DOGBONE  — circular cutout centred on the corner vertex; diameter = 2 × radius.
 *   CIRCULAR — same geometry as dogbone (alias retained for compatibility with
 *              CAD software conventions that distinguish placement strategy).
 *
 * Relief generation is a Phase C operation that modifies a ShellId in-place (via
 * a copy-on-write snapshot) and returns the updated ShellId.
 *
 * Task: T067
 */

#include <string>

namespace mcp_cad {

enum class ReliefType {
  DOGBONE,   // most common: circular cut centred on inside corner vertex
  CIRCULAR,  // variant: circular cut at radius from corner, slightly offset
};

}  // namespace mcp_cad
