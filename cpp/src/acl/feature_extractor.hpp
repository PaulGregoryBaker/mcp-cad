#pragma once

/**
 * FeatureExtractor — Topology → Feature classification interface (ACL).
 *
 * The Anti-Corruption Layer translates OCCT topology into Manufacturing Domain
 * feature concepts (Bend, Hole, Flange, Relief).
 *
 * Tasks: T056
 */

#include <string>
#include <memory>
#include <vector>
#include "../geometry/topology_graph.hpp"

namespace mcp_cad {

// ─── Feature types (mirror of TypeScript data-model) ─────────────────────────

struct BendFeature {
  std::string featureId;
  double      angleDeg;
  double      radiusMm;
  double      lengthMm;
  double      kFactor;
  double      bendAllowanceMm;
  std::vector<std::string> faceIds;
};

struct HoleFeature {
  std::string featureId;
  double      centerX;
  double      centerY;
  double      diameterMm;
  bool        throughHole;
  std::string faceId;
};

struct FlangeFeature {
  std::string featureId;
  double      widthMm;
  double      lengthMm;
  std::string adjacentBendId;
  std::string faceId;
};

struct ReliefFeature {
  std::string featureId;
  enum class Type { DOGBONE, CIRCULAR } type;
  double      radiusMm;
  double      locationX;
  double      locationY;
};

struct FeatureSet {
  std::string              shellId;
  std::vector<BendFeature>   bends;
  std::vector<HoleFeature>   holes;
  std::vector<FlangeFeature> flanges;
  std::vector<ReliefFeature> reliefs;
};

// ─── FeatureExtractor interface ───────────────────────────────────────────────

/**
 * FeatureExtractor translates a TopologyGraph into a FeatureSet.
 * The implementation uses face/edge classification heuristics.
 *
 * Accuracy target: >90% on tier-1 and tier-2 STEP fixtures (Task T062).
 */
class FeatureExtractor {
public:
  static std::unique_ptr<FeatureExtractor> create();
  virtual ~FeatureExtractor() = default;

  /**
   * Extract all manufacturing features from a topology graph.
   */
  virtual FeatureSet composeFeatureSet(const TopologyGraph& graph,
                                        const std::string&   shellId,
                                        double materialThicknessMm,
                                        double defaultKFactor) = 0;

  // Individual classification methods (exposed for unit testing)
  virtual std::vector<BendFeature>   extractBends(const TopologyGraph& graph,
                                                   double kFactor) = 0;
  virtual std::vector<HoleFeature>   extractHoles(const TopologyGraph& graph) = 0;
  virtual std::vector<FlangeFeature> extractFlanges(const TopologyGraph& graph,
                                                     const std::vector<BendFeature>& bends) = 0;
};

}  // namespace mcp_cad
