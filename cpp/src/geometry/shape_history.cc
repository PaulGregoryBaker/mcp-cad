/**
 * captureHistory — OCCT topology history capture implementation.
 *
 * This file includes OCCT headers (alongside geometry_service.cc) and is the
 * only other translation unit in the geometry layer that does so.
 *
 * Tasks: T020.
 */

#include "shape_history.hpp"

#include <BRepBuilderAPI_MakeShape.hxx>
#include <TopoDS_Shape.hxx>
#include <TopExp_Explorer.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>

namespace mcp_cad {

std::vector<ShapeHistoryRecord> captureHistory(
    BRepBuilderAPI_MakeShape&                              algo,
    const TopoDS_Shape&                                    inputShape,
    const std::function<std::string(const TopoDS_Shape&)>& resolveId,
    const std::string&                                     operationLabel)
{
  std::vector<ShapeHistoryRecord> records;

  for (TopExp_Explorer ex(inputShape, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Shape& face = ex.Current();
    std::string origId = resolveId(face);
    if (origId.empty()) continue;

    // Modified faces: input face was changed into one or more output faces
    const TopTools_ListOfShape& modList = algo.Modified(face);
    for (TopTools_ListIteratorOfListOfShape it(modList); it.More(); it.Next()) {
      std::string newId = resolveId(it.Value());
      records.push_back({"modified", origId, newId, operationLabel});
    }

    // Generated faces: a new face was derived from this input face
    const TopTools_ListOfShape& genList = algo.Generated(face);
    for (TopTools_ListIteratorOfListOfShape it(genList); it.More(); it.Next()) {
      std::string newId = resolveId(it.Value());
      records.push_back({"generated", origId, newId, operationLabel});
    }

    // Deleted faces: the input face has no counterpart in the result
    if (algo.IsDeleted(face)) {
      records.push_back({"deleted", origId, std::string(""), operationLabel});
    }
  }

  return records;
}

}  // namespace mcp_cad
