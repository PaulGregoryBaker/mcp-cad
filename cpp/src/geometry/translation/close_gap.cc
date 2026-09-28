#include "close_gap.hpp"
#include <cmath>
#include <algorithm>

namespace mcp_cad::translation {

namespace {

Point3 Midpoint(const std::vector<Point3>& pts) {
  Point3 m{0, 0, 0};
  if (pts.empty()) return m;
  for (const auto& p : pts) {
    m.x += p.x;
    m.y += p.y;
    m.z += p.z;
  }
  double n = static_cast<double>(pts.size());
  m.x /= n;
  m.y /= n;
  m.z /= n;
  return m;
}

}  // namespace

CloseGapResult ComputeCloseGapDelta(
    const std::vector<Point3>& edgeA3d,
    const std::vector<Point3>& edgeB3d,
    const Transform3& panelBPose) {

  Point3 midA = Midpoint(edgeA3d);
  Point3 midB = Midpoint(edgeB3d);

  // 3D gap vector: from B to A in world space
  double gx = midA.x - midB.x;
  double gy = midA.y - midB.y;
  double gz = midA.z - midB.z;
  double gapMm = std::sqrt(gx * gx + gy * gy + gz * gz);

  // Map the 3D gap vector to F (the part's flat frame) via the panel's
  // inverse pose: delta_2d = R⁻¹ × gap_3d.
  // R⁻¹ is the transpose of R (R is orthonormal).
  const double* r = panelBPose.r;
  double dx = r[0] * gx + r[1] * gy + r[2] * gz;
  double dy = r[3] * gx + r[4] * gy + r[5] * gz;
  // dz = r[6]*gx + r[7]*gy + r[8]*gz — not needed (2D delta in F)

  return {dx, dy, gapMm};
}

}  // namespace mcp_cad::translation
