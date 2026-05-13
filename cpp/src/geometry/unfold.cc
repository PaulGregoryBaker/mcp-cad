/**
 * Sheet metal unfolding implementation.
 *
 * Approach: custom OCC-based unfolding (Research Phase T004 selected OCC over
 * CadQuery Python due to in-process performance and dependency simplicity).
 *
 * Algorithm (Phase C MVP — bounding-box approximation):
 *   1. Retrieve shell shape from ShellState.
 *   2. Compute 3D bounding box via BRepBndLib::Add().
 *   3. Use bbox extents as flat blank dimensions (conservative overestimate).
 *   4. K-factor bend allowance applied by the caller (geometry_service.cc).
 *
 * Future improvement (post-MVP): full unfolding via BRepOffsetAPI_MakeOffset
 * or OCCT's sheet metal development algorithms when available in 7.8.x.
 *
 * K-factor bend allowance formula:
 *   BA = (π/180) × angle × (radius + k × thickness)
 *
 * The actual unfoldShell() method is implemented in geometry_service.cc, which
 * is the single OCCT-including translation unit. This file documents the design
 * intent and can be evolved to hold the standalone algorithm.
 *
 * Task: T070
 */

// This file intentionally contains no code — the implementation lives in
// geometry_service.cc to maintain the invariant that OCCT headers are
// included in exactly one TU (see geometry_service.cc header comment).
//
// To extract the algorithm here in a future refactoring:
//   1. Add an OCCT-free interface UnfoldAlgorithm in unfold.hpp.
//   2. Move the OCC calls from geometry_service.cc into this file.
//   3. Include this file in the CMakeLists.txt geometry_engine sources.
