#pragma once

/**
 * validation/findings.hpp — the Finding struct and supporting types.
 *
 * These mirror the v2 MCP contract's Finding schema (rebuild/15-mcp-contract.md
 * §1) exactly — the NAPI binding marshals them directly into the wire shape.
 *
 * All types are plain data, no OCCT dependency, no shared state. A rules
 * engine finding is never a hard error (the evaluateFindings binding always
 * returns successfully) — the resource layer decides how to present them.
 */

#include <string>
#include <vector>
#include <optional>

namespace mcp_cad::validation {

enum class FindingSeverity {
  kError,
  kWarning,
  kInfo,
};

struct EntityAnchor {
  std::string kind;   // "part" | "region_panel" | "bend"
  std::string id;
};

struct RecommendedFix {
  std::string tool;
  // params as a JSON string — avoids a recursive variant type in C++.
  // The TS side parses this into the contract's {tool, params} object.
  std::string paramsJson;
};

struct Finding {
  std::string code;           // e.g. "MIN_BEND_RADIUS", "HOLE_TOO_CLOSE_TO_BEND"
  FindingSeverity severity;
  std::string message;
  std::vector<EntityAnchor> anchors;
  std::optional<RecommendedFix> recommendedFix;
};

}  // namespace mcp_cad::validation
