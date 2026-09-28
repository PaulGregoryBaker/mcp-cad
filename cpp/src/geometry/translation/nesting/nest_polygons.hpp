#pragma once

/**
 * @file nest_polygons.hpp
 * @brief Irregular-shape 2-D nesting on stock sheets (libnest2d).
 *
 * Replaces the v1/v2 rectangular Shelf-Next-Fit packer with libnest2d's
 * BottomLeftPlacer over the Clipper backend, so concave/irregular flat
 * outlines nest tightly. See rebuild/21-nesting-libnest2d.md for the design.
 *
 * Pure 2-D geometry over flat-pattern point arrays — no OCCT involvement
 * (16-kernel-port.md: `simulate_nesting` touches no kernel). All input/output
 * coordinates are millimetres in the sheet frame.
 */

#include "../manufacturing_graph_evaluator.hpp"  // Point2

#include <string>
#include <vector>

namespace mcp_cad::translation {

enum class NestErrorCode {
  kNone,
  kInvalidInput,          // empty part list, <3-vertex outline, bad sheet/options
  kInvalidCuttingWidth,   // cuttingWidthMm <= 0 or > maxKerfWidthMm
  kPartExceedsSheet,      // a part cannot fit on one sheet even alone
};

struct NestCircleHole {
  double cx = 0.0;
  double cy = 0.0;
  double radiusMm = 0.0;
};

struct NestPolygonInput {
  std::string id;
  std::vector<Point2> outer;                     // CCW, >= 3 vertices, not closed
  std::vector<std::vector<Point2>> holes;        // optional, each not closed
  std::vector<NestCircleHole> circleHoles;       // optional, exact (never tessellated)
};

struct NestPolygonPlacement {
  std::string id;
  int copyIndex = 0;
  int sheetIndex = 0;
  double x = 0.0;         // translation applied, mm (sheet frame)
  double y = 0.0;
  double rotationDeg = 0.0;                       // rotation applied, degrees
  std::vector<Point2> outline;                    // transformed, sheet frame
  std::vector<std::vector<Point2>> holes;         // transformed, sheet frame
  std::vector<NestCircleHole> circleHoles;        // transformed centres, sheet frame
};

struct NestPolygonOptions {
  double cuttingWidthMm = 0.15;      // kerf; inter-part clearance base
  double maxKerfWidthMm = 0.2;       // tooling ceiling; cuttingWidthMm must be <= this
  double safetyGapMm = 0.0;          // added to cutting width -> dist
  double sheetMarginMm = 2.0;        // min distance from outline to sheet edge
  double placementAccuracy = 0.65;   // 0..1, NfpPlacer search effort
  std::vector<double> rotationsDeg = {0.0, 90.0, 180.0, 270.0};
  int copies = 1;                    // explicit copy count of each part; -1 = fill
};

struct NestPolygonResult {
  bool ok = false;
  NestErrorCode errorCode = NestErrorCode::kNone;
  std::string message;
  std::vector<NestPolygonPlacement> placements;
  double utilisationPct = 0.0;
  int sheetsRequired = 0;
};

NestErrorCode NestErrorCodeFromString(const std::string& s);
std::string NestErrorCodeToString(NestErrorCode code);

// Nest copies of every input part onto the smallest number of sheets.
// `copies == -1` (fill mode) packs as many complete kits (one copy of each
// part, in input order) as fit. A part that cannot be placed on an empty
// sheet fails with kPartExceedsSheet — never silently dropped.
NestPolygonResult nestPolygons(
    const std::vector<NestPolygonInput>& parts,
    double sheetWidthMm,
    double sheetHeightMm,
    const NestPolygonOptions& opts = {});

}  // namespace mcp_cad::translation
