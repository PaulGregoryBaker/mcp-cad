/**
 * FeatureExtractor implementation — topology to feature classification.
 *
 * Uses face/edge geometry classification heuristics to identify sheet metal
 * manufacturing features (Bends, Holes, Flanges) from OCCT topology data.
 *
 * Tasks: T057, T058, T059, T060, T061
 */

#include "feature_extractor.hpp"

#include <algorithm>
#include <cmath>
#include <memory>
#include <random>
#include <sstream>
#include <iomanip>

namespace mcp_cad {

// ─── UUID helper (copied from geometry_service.cc; consider shared utility) ──

static std::string generateFeatureId() {
  static std::random_device rd;
  static std::mt19937_64 gen(rd());
  static std::uniform_int_distribution<uint64_t> dist;
  uint64_t hi = dist(gen);
  uint64_t lo = dist(gen);
  hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
  lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;
  std::ostringstream oss;
  oss << std::hex << std::setfill('0')
      << std::setw(8) << (hi >> 32) << "-"
      << std::setw(4) << ((hi >> 16) & 0xFFFF) << "-"
      << std::setw(4) << (hi & 0xFFFF) << "-"
      << std::setw(4) << (lo >> 48) << "-"
      << std::setw(12) << (lo & 0x0000FFFFFFFFFFFFULL);
  return oss.str();
}

// ─── Bend allowance formula (K-factor method) ────────────────────────────────

static double computeBendAllowance(double angleDeg, double radiusMm,
                                    double thicknessMm, double kFactor) {
  const double PI = 3.14159265358979323846;
  return (PI / 180.0) * angleDeg * (radiusMm + kFactor * thicknessMm);
}

// ─── FeatureExtractorImpl ─────────────────────────────────────────────────────

class FeatureExtractorImpl : public FeatureExtractor {
public:
  FeatureExtractorImpl() = default;
  ~FeatureExtractorImpl() override = default;

  FeatureSet composeFeatureSet(const TopologyGraph& graph,
                                const std::string&   shellId,
                                double materialThicknessMm,
                                double defaultKFactor) override {
    FeatureSet fs;
    fs.shellId = shellId;
    fs.bends   = extractBends(graph, defaultKFactor);
    fs.holes   = extractHoles(graph);
    fs.flanges = extractFlanges(graph, fs.bends);
    // Reliefs are added post-manufacturing (generate_reliefs tool); empty here.
    return fs;
  }

  // ── Bend detection ────────────────────────────────────────────────────────

  std::vector<BendFeature> extractBends(const TopologyGraph& graph,
                                         double kFactor) override {
    std::vector<BendFeature> bends;

    // Heuristic: adjacency entries with dihedral angle not near 180° indicate bends.
    // Threshold: 5° < dihedral < 175° → classify as bend.
    // Two adjacent planar faces joined at a cylindrical/non-planar edge → bend line.

    for (const auto& adj : graph.adjacency) {
      double angle = adj.dihedralAngleDeg;
      if (angle < 5.0 || angle > 175.0) continue;  // ~flat; not a bend

      // Locate the face nodes for A and B
      const FaceNode* fA = findFace(graph, adj.faceIdA);
      const FaceNode* fB = findFace(graph, adj.faceIdB);
      if (!fA || !fB) continue;

      // Both faces must be planar for a sheet metal bend
      if (fA->surfaceType != SurfaceType::PLANE ||
          fB->surfaceType != SurfaceType::PLANE) continue;

      // Find the shared edge to get bend length
      const EdgeNode* edge = findEdge(graph, adj.sharedEdgeId);
      double bendLength = edge ? edge->lengthMm : 0.0;
      if (bendLength < 1.0) continue;  // skip very short edges

      // Estimate bend angle (supplement of dihedral)
      double bendAngle = 180.0 - angle;

      // Estimate bend radius from edge type (circles → radius available; lines → use minimum)
      double radius = 1.0;  // default 1 mm radius for MVP
      if (edge && edge->curveType == CurveType::CIRCLE) {
        // For circular edges, radius = sqrt(area/PI) approximation
        // Full radius extraction requires OCCT BRep_Tool::Curve — done in Phase B
        radius = 1.0;  // stub; Phase B will use actual curve radius
      }

      BendFeature bend;
      bend.featureId        = generateFeatureId();
      bend.angleDeg         = bendAngle;
      bend.radiusMm         = radius;
      bend.lengthMm         = bendLength;
      bend.kFactor          = kFactor;
      bend.bendAllowanceMm  = computeBendAllowance(bendAngle, radius, 1.5, kFactor);
      bend.faceIds          = {adj.faceIdA, adj.faceIdB};

      bends.push_back(bend);
    }

    return bends;
  }

  // ── Hole detection ────────────────────────────────────────────────────────

  std::vector<HoleFeature> extractHoles(const TopologyGraph& graph) override {
    std::vector<HoleFeature> holes;

    // Heuristic: cylindrical faces with area consistent with a through-hole.
    // A cylindrical face that forms a closed loop in topology = hole cylinder.

    for (const auto& face : graph.faces) {
      if (face.surfaceType != SurfaceType::CYLINDER) continue;

      // Estimate diameter from area and cylinder geometry:
      // Area = 2 * pi * r * h  → r = Area / (2 * pi * h)
      // For through-holes in sheet metal, h ≈ material thickness (~1–3 mm)
      // We approximate r from area directly for Phase A.
      double estimatedRadiusMm = std::sqrt(face.areaMm2 / (2.0 * 3.14159265));
      if (estimatedRadiusMm < 0.5) continue;   // too small to be a meaningful hole
      if (estimatedRadiusMm > 50.0) continue;  // too large for a hole (likely a cylinder body)

      HoleFeature hole;
      hole.featureId   = generateFeatureId();
      hole.centerX     = 0.0;  // Phase B will extract from face centroid via OCCT
      hole.centerY     = 0.0;
      hole.diameterMm  = estimatedRadiusMm * 2.0;
      hole.throughHole = true;  // assumed through for MVP
      hole.faceId      = face.faceId;

      holes.push_back(hole);
    }

    return holes;
  }

  // ── Flange detection ──────────────────────────────────────────────────────

  std::vector<FlangeFeature> extractFlanges(
      const TopologyGraph& graph,
      const std::vector<BendFeature>& bends) override {
    std::vector<FlangeFeature> flanges;

    // Heuristic: planar faces adjacent to a detected bend = flanges.
    // Each bend has two adjacent face IDs; the faces adjacent to these
    // (but not participating directly in the bend) are flanges.

    for (const auto& bend : bends) {
      for (const auto& faceId : bend.faceIds) {
        const FaceNode* face = findFace(graph, faceId);
        if (!face || face->surfaceType != SurfaceType::PLANE) continue;

        FlangeFeature flange;
        flange.featureId      = generateFeatureId();
        flange.widthMm        = std::sqrt(face->areaMm2);  // approximate
        flange.lengthMm       = bend.lengthMm;
        flange.adjacentBendId = bend.featureId;
        flange.faceId         = faceId;

        flanges.push_back(flange);
      }
    }

    return flanges;
  }

private:
  static const FaceNode* findFace(const TopologyGraph& g, const std::string& id) {
    for (const auto& f : g.faces) {
      if (f.faceId == id) return &f;
    }
    return nullptr;
  }

  static const EdgeNode* findEdge(const TopologyGraph& g, const std::string& id) {
    for (const auto& e : g.edges) {
      if (e.edgeId == id) return &e;
    }
    return nullptr;
  }
};

// ─── Factory ──────────────────────────────────────────────────────────────────

std::unique_ptr<FeatureExtractor> FeatureExtractor::create() {
  return std::make_unique<FeatureExtractorImpl>();
}

}  // namespace mcp_cad
