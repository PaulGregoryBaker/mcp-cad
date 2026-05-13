/**
 * @file nesting.hpp
 * @brief 2-D rectangular bin-packing (nesting) for sheet metal flat blanks.
 *
 * ## Algorithm
 *
 * Implements **Shelf-Next-Fit Decreasing (SNFD)** — a greedy row-packing
 * heuristic that is optimal for uniform-height pieces and performs well for
 * near-uniform pieces (typical unfolded sheet metal blanks):
 *
 *  1. Sort pieces by height descending (ties broken by width descending).
 *  2. Maintain a current row: (x_cursor, y_cursor, row_height).
 *  3. For each piece:
 *     a. If piece fits in the current row width: place, advance x_cursor.
 *     b. Else: close current row, open new row at (0, y_cursor + row_height).
 *     c. If new row exceeds sheet height: advance to next sheet index.
 *  4. Utilisation = Σ(part_area) / (sheetsRequired × sheetArea).
 *
 * ## Sheet sizes (standard 2-D nesting)
 *
 * | Label      | Width (mm) | Height (mm) |
 * |------------|-----------|-------------|
 * | Full sheet | 2440      | 1220        |
 * | 3/4 sheet  | 2440      | 915         |
 * | Half sheet | 1220      | 610         |
 *
 * ## Output
 *
 * Returns `NestResult` (defined in geometry_service.hpp):
 * - `nestId`         — UUID for this nesting run
 * - `placements`     — (unfoldId, sheetIndex, x, y, rotationDeg) per part
 * - `utilisationPct` — 0–100 material utilisation percentage
 * - `sheetsRequired` — number of sheets needed
 * - `svgPreview`     — SVG string visualising the layout (for debugging)
 *
 * ## Extension hook (Constitution Principle IX)
 *
 * The function signature is:
 *   NestResult nestRectangles(
 *       const std::vector<UnfoldState>& unfolds,
 *       double sheetWidthMm,
 *       double sheetHeightMm);
 *
 * This is called by GeometryService::nestShells() after resolving UnfoldIds
 * to UnfoldState objects. A future upgrade to libnest2d (or another solver)
 * only needs to replace this function — the GeometryService interface is
 * unchanged.
 *
 * Tasks: T085, T088
 */

#pragma once
#include <string>
#include <vector>

// Forward declarations match geometry_service.hpp
using UnfoldId = std::string;

struct NestInput {
  UnfoldId id;
  double   widthMm;
  double   heightMm;
};

struct NestPlacementLocal {
  UnfoldId id;
  int      sheetIndex;
  double   x;
  double   y;
};

struct NestOutput {
  std::vector<NestPlacementLocal> placements;
  double                          utilisationPct;
  int                             sheetsRequired;
  std::string                     svgPreview;
};

/**
 * Pack rectangular pieces into the smallest number of sheets.
 *
 * @param pieces        List of (id, widthMm, heightMm) pieces to pack.
 * @param sheetWidthMm  Sheet width in mm.
 * @param sheetHeightMm Sheet height in mm.
 * @returns             NestOutput with placements and utilisation.
 */
NestOutput nestRectangles(
    const std::vector<NestInput>& pieces,
    double sheetWidthMm,
    double sheetHeightMm);
