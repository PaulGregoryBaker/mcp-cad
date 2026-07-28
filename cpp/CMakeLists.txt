cmake_minimum_required(VERSION 3.26)

# ─── vcpkg integration ───────────────────────────────────────────────────────
# Expects VCPKG_ROOT or CMAKE_TOOLCHAIN_FILE set externally.
# Fallback: auto-detect from environment variable or common paths.
if(DEFINED ENV{VCPKG_ROOT} AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
      CACHE STRING "vcpkg toolchain file")
elseif(EXISTS "C:/vcpkg/scripts/buildsystems/vcpkg.cmake" AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  set(CMAKE_TOOLCHAIN_FILE "C:/vcpkg/scripts/buildsystems/vcpkg.cmake"
      CACHE STRING "vcpkg toolchain file")
endif()

project(mcp_cad_geometry VERSION 0.1.0 LANGUAGES CXX)

if (MSVC AND CMAKE_JS_VERSION)
  # Override cmake-js forced /MT to be compatible with vcpkg libraries compiled with /MD
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

# ─── Find packages (via vcpkg) ───────────────────────────────────────────────
# OpenCASCADE's config package expects module components (e.g. FoundationClasses),
# not library names. Loading without components imports all standard modules.
find_package(OpenCASCADE REQUIRED)
find_package(Catch2 3 REQUIRED)

# libnest2d is NOT required — the project uses a built-in Shelf-Next-Fit
# Decreasing rectangular bin-packing algorithm (see nesting.hpp).

# ─── Compile flags ───────────────────────────────────────────────────────────
if(MSVC)
  add_compile_options(
    /W4
    $<$<CONFIG:Release>:/O2>
    $<$<CONFIG:Debug>:/Od>
    $<$<CONFIG:Debug>:/Zi>
  )
else()
  add_compile_options(
    -Wall -Wextra -Wpedantic
    $<$<CONFIG:Release>:-O2>
    $<$<CONFIG:Debug>:-g>
    $<$<CONFIG:Debug>:-O0>
  )
endif()

# AddressSanitizer support (enabled via cmake -DASAN=ON)
option(ASAN "Enable AddressSanitizer" OFF)
if(ASAN)
  if(MSVC)
    # MSVC AddressSanitizer (VS 2019 16.9+)
    add_compile_options(/fsanitize=address)
    # MSVC ASAN does not need a separate link flag; the runtime is linked automatically.
    # Disable incremental linking which is incompatible with ASAN on MSVC.
    add_link_options(/INCREMENTAL:NO)
  else()
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address)
  endif()
endif()

# ─── Geometry Engine Library ─────────────────────────────────────────────────
add_library(geometry_engine STATIC
  src/geometry/geometry_service_utils.cc
  src/geometry/geometry_service_core.cc
  src/geometry/geometry_service_booleans.cc
  src/geometry/geometry_service_transforms.cc
  src/geometry/geometry_service_modelling.cc
  src/geometry/geometry_service_shell.cc
  src/geometry/geometry_service_export.cc
  src/geometry/geometry_service_measurement.cc
  src/geometry/geometry_service_assembly.cc
  src/geometry/geometry_service_validation.cc
  src/geometry/geometry_service_sheet_metal.cc
  src/geometry/geometry_service_translation.cc
  src/geometry/shape_history.cc
  src/geometry/topology_graph.cc
  src/geometry/translation/manufacturing_graph_evaluator.cc
  src/geometry/translation/part_solid_construction.cc
  src/geometry/translation/point_mapping.cc
  src/geometry/translation/part_merge.cc
  src/geometry/translation/step_reconciliation.cc
  src/geometry/translation/polygon_boolean.cc
  src/geometry/translation/ring_containment.cc
  src/geometry/translation/cut_panel.cc
  src/geometry/translation/close_gap.cc
  src/geometry/validation/rules_engine.cc
  src/geometry/validation/rules/bend_radius.cc
  src/geometry/validation/rules/bend_angle.cc
  src/geometry/validation/rules/hole_diameter.cc
  src/geometry/validation/rules/hole_to_bend.cc
  src/geometry/validation/rules/hole_to_edge.cc
  src/geometry/validation/rules/hole_to_hole.cc
  src/geometry/validation/rules/flange_width.cc
  src/acl/feature_extractor.cc
)

target_include_directories(geometry_engine
  PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Link all OCCT modules exported by this package revision.
target_link_libraries(geometry_engine PUBLIC
  ${OpenCASCADE_LIBRARIES}
)

# ─── NAPI Addon (built separately via cmake-js) ───────────────────────────────
# See src/napi/CMakeLists.txt for addon build.
# Run: cmake-js build from cpp/ directory.
if (CMAKE_JS_VERSION)
  set(node-addon-api_SOURCE_DIR "${CMAKE_SOURCE_DIR}/../ts/node_modules/node-addon-api" CACHE STRING "")
  add_subdirectory(src/napi)
endif()

# ─── Test Executable ─────────────────────────────────────────────────────────
add_executable(geometry_tests
  tests/geometry_test.cc
  tests/tab_slot_test.cc
  tests/feature_extractor_test.cc
  tests/acl_integration_test.cc
  tests/ge_integration_test.cc
  tests/ge_decompose_integration_test.cc
  tests/determinism_test.cc
  tests/nesting_test.cc
  tests/production_workflow_test.cc
  tests/manufacturing_graph_evaluator_test.cc
  tests/part_solid_construction_test.cc
  tests/point_mapping_test.cc
  tests/part_merge_test.cc
  tests/step_reconciliation_test.cc
  tests/polygon_boolean_test.cc
  tests/ring_containment_test.cc
  tests/cut_panel_test.cc
  tests/validation_rules_test.cc
  tests/close_gap_test.cc
)

target_include_directories(geometry_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(geometry_tests PRIVATE
  geometry_engine
  Catch2::Catch2WithMain
)

# NAPI contract tests (separate target)
add_executable(napi_contract_tests
  tests/napi_contract/napi_types_test.cc
)

target_include_directories(napi_contract_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(napi_contract_tests PRIVATE
  geometry_engine
  Catch2::Catch2WithMain
)

# ─── Fixture generator utility (T120) ───────────────────────────────────────
add_executable(generate_fixtures
  tools/generate_fixtures.cc
)
target_include_directories(generate_fixtures PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_link_libraries(generate_fixtures PRIVATE
  ${OpenCASCADE_LIBRARIES}
)

# ─── CTest integration ───────────────────────────────────────────────────────
include(CTest)
include(Catch)
file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/test-reports)
catch_discover_tests(geometry_tests
  REPORTER XML
  OUTPUT_DIR ${CMAKE_BINARY_DIR}/test-reports
)
catch_discover_tests(napi_contract_tests
  REPORTER XML
  OUTPUT_DIR ${CMAKE_BINARY_DIR}/test-reports
)
