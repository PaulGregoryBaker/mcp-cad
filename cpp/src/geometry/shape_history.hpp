#pragma once
/**
 * Shape history — captures OCCT topology mutation records.
 *
 * ShapeHistoryRecord is the public type; captureHistory is the helper that
 * populates records from a completed OCCT build operation.
 *
 * Only ShapeHistoryRecord uses standard C++ types so this header is safe to
 * include from geometry_service.hpp without pulling in OCCT.  captureHistory
 * uses OCCT types via forward declarations; callers must include OCCT headers
 * themselves before calling it.
 *
 * Tasks: T019.
 */

#include <string>
#include <vector>
#include <functional>

// OCCT forward declarations — never add #include <OCCT_*.hxx> to this file.
class BRepBuilderAPI_MakeShape;
class TopoDS_Shape;

namespace mcp_cad {

struct ShapeHistoryRecord {
  std::string verdict;          // "modified" | "generated" | "deleted"
  std::string originalId;       // face hash-id in the pre-operation shape
  std::string newId;            // face hash-id in the post-operation shape; "" when deleted
  std::string operationLabel;   // tool name, e.g. "split_body_by_bends"
};

/**
 * Captures face-level history from a completed OCCT build operation.
 *
 * Iterates every face in inputShape and queries algo.Modified / Generated /
 * IsDeleted.  Faces whose resolveId returns "" are silently skipped (unresolved
 * topology — a known degenerate case in Phase 0).
 *
 * @param algo           Completed MakeShape (BRepAlgoAPI_Cut, Common, MakePrism …)
 * @param inputShape     The shape whose faces are the "before" side
 * @param resolveId      Maps a TopoDS_Shape to its registered face-id string
 * @param operationLabel Added verbatim to every emitted record
 */
std::vector<ShapeHistoryRecord> captureHistory(
    BRepBuilderAPI_MakeShape&                              algo,
    const TopoDS_Shape&                                    inputShape,
    const std::function<std::string(const TopoDS_Shape&)>& resolveId,
    const std::string&                                     operationLabel);

}  // namespace mcp_cad
