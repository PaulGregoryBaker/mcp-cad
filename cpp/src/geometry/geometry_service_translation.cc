/**
 * geometry_service_translation.cc — GeometryServiceImpl::constructPartSolid,
 * delegating directly to translation::ConstructPartSolid (Port D-lite). This
 * translation unit owns the include of part_solid_construction.hpp, keeping
 * geometry_service.hpp itself free of any OCCT-touching header (constitution
 * principle II's facade boundary) — part_solid_construction.hpp is the one
 * translation:: header that DOES touch OCCT.
 */

#include "geometry_service_impl.hpp"
#include "translation/part_solid_construction.hpp"

namespace mcp_cad {

ConstructPartSolidResultDTO GeometryServiceImpl::constructPartSolid(
    const translation::EvaluateResult& layout, double thicknessMm) {
  translation::ConstructPartSolidResult result =
      translation::ConstructPartSolid(state_, layout, thicknessMm);

  ConstructPartSolidResultDTO dto;
  dto.ok = result.ok;
  dto.shellId = result.shellId;
  dto.errorCode = result.errorCode;
  dto.message = result.message;
  return dto;
}

}  // namespace mcp_cad
