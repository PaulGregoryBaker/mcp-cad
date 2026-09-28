/**
 * close_gap tests — aligned with the TS integration test.
 */
#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/close_gap.hpp"

using namespace mcp_cad::translation;

TEST_CASE("CloseGap: zero gap when edges already touch", "[translation][close_gap]") {
  std::vector<Point3> edgeA = {{0, 0, 0}, {10, 0, 0}};
  std::vector<Point3> edgeB = {{0, 0, 0}, {10, 0, 0}};
  Transform3 identity = Transform3::Identity();

  auto result = ComputeCloseGapDelta(edgeA, edgeB, identity);
  CHECK(result.gapMm == 0.0);
  CHECK(result.deltaX == 0.0);
  CHECK(result.deltaY == 0.0);
}

TEST_CASE("CloseGap: computes correct 2D delta for X-gap with identity pose",
          "[translation][close_gap]") {
  std::vector<Point3> edgeA = {{0, 0, 0}, {0, 10, 0}};
  std::vector<Point3> edgeB = {{5, 0, 0}, {5, 10, 0}};
  Transform3 identity = Transform3::Identity();

  auto result = ComputeCloseGapDelta(edgeA, edgeB, identity);
  CHECK(result.gapMm == 5.0);
  CHECK(result.deltaX == -5.0);
  CHECK(result.deltaY == 0.0);
}

TEST_CASE("CloseGap: rotates gap vector through panel pose", "[translation][close_gap]") {
  std::vector<Point3> edgeA = {{0, 0, 0}, {0, 5, 0}};
  std::vector<Point3> edgeB = {{10, 0, 0}, {10, 5, 0}};

  Transform3 rot90Z;
  rot90Z.r[0] = 0; rot90Z.r[1] = -1; rot90Z.r[2] = 0;
  rot90Z.r[3] = 1; rot90Z.r[4] = 0;  rot90Z.r[5] = 0;
  rot90Z.r[6] = 0; rot90Z.r[7] = 0;  rot90Z.r[8] = 1;

  auto result = ComputeCloseGapDelta(edgeA, edgeB, rot90Z);
  CHECK(result.gapMm == 10.0);
  CHECK(result.deltaX == 0.0);
  CHECK(result.deltaY == -10.0);
}
