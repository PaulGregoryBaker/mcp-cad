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

# libnest2d (header-only, wired manually — see rebuild/21-nesting-libnest2d.md).
# We populate the sources but deliberately do NOT add_subdirectory(): libnest2d's
# own CMake is broken on modern CMake (find_package(Boost ... COMPONENTS headers)
# is rejected by FindBoost) and its clipper backend hard-requires Boost headers
# our compile path never includes. Instead we define the backend macros and link
# the vcpkg Clipper/NLopt directly (libnest2d README integration option 2).
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)   # FetchContent_Populate-only (no add_subdirectory)
endif()
FetchContent_Declare(libnest2d
  GIT_REPOSITORY https://github.com/tamasmeszaros/libnest2d.git
  GIT_TAG        663daa69e1d7478669f714218e27681edbc96640
  GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(libnest2d)
if(NOT libnest2d_POPULATED)
  FetchContent_Populate(libnest2d)
endif()
set(LIBNEST2D_INCLUDE_DIR      ${libnest2d_SOURCE_DIR}/include)
set(LIBNEST2D_CMAKE_MODULES_DIR ${libnest2d_SOURCE_DIR}/cmake_modules)

# libnest2d's own FindNLopt module defines the imported target NLopt::nlopt
# from vcpkg-installed nlopt. Clipper is NOT taken from vcpkg — its SourceForge
# download is unreliable — so we fetch the GitHub mirror libnest2d itself uses
# and compile clipper.cpp directly into geometry_engine below.
FetchContent_Declare(libpolyclipping
  GIT_REPOSITORY https://github.com/tamasmeszaros/libpolyclipping.git
  GIT_TAG        784ff113071f1fa7832ebe74667f2fd0756c634f
  GIT_SHALLOW    TRUE
)
FetchContent_GetProperties(libpolyclipping)
if(NOT libpolyclipping_POPULATED)
  FetchContent_Populate(libpolyclipping)
endif()
set(LIBCLIPPER_INCLUDE_DIR ${libpolyclipping_SOURCE_DIR})

list(APPEND CMAKE_MODULE_PATH ${LIBNEST2D_CMAKE_MODULES_DIR})
find_package(NLopt REQUIRED)
# The clipper backend unconditionally includes libnest2d/utils/boost_alg.hpp
# (Boost.Geometry), so header-only Boost is a compile-time requirement.
find_package(Boost REQUIRED)

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
  src/geometry/translation/part_split.cc
  src/geometry/translation/step_reconciliation.cc
  src/geometry/translation/polygon_boolean.cc
  src/geometry/translation/flat_outline.cc
  src/geometry/translation/ring_containment.cc
  src/geometry/translation/cut_panel.cc
  src/geometry/translation/close_gap.cc
  src/geometry/translation/add_flange.cc
  src/geometry/translation/rip_edge.cc
  src/geometry/translation/generate_reliefs.cc
  src/geometry/translation/split_by_plane.cc
  src/geometry/translation/nesting/nest_polygons.cc
  ${libpolyclipping_SOURCE_DIR}/clipper.cpp
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
  PUBLIC  ${LIBNEST2D_INCLUDE_DIR}
  PUBLIC  ${LIBCLIPPER_INCLUDE_DIR}
)

# Header-only libnest2d backend selection (rebuild/21-nesting-libnest2d.md §3).
# LIBNEST2D_THREADING_std is required — with no threading macro, __parallel::enumerate
# compiles to a no-op and NfpPlacer computes no NFP.
target_compile_definitions(geometry_engine PUBLIC
  LIBNEST2D_GEOMETRIES_clipper
  LIBNEST2D_OPTIMIZER_nlopt
  LIBNEST2D_THREADING_std
)

# Link all OCCT modules exported by this package revision.
target_link_libraries(geometry_engine PUBLIC
  ${OpenCASCADE_LIBRARIES}
  NLopt::nlopt
  Boost::headers
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
  tests/nest_polygons_test.cc
  tests/production_workflow_test.cc
  tests/manufacturing_graph_evaluator_test.cc
  tests/part_solid_construction_test.cc
  tests/point_mapping_test.cc
  tests/part_merge_test.cc
  tests/part_split_test.cc
  tests/step_reconciliation_test.cc
  tests/polygon_boolean_test.cc
  tests/flat_outline_test.cc
  tests/ring_containment_test.cc
  tests/cut_panel_test.cc
  tests/validation_rules_test.cc
  tests/close_gap_test.cc
  tests/add_flange_test.cc
  tests/rip_edge_test.cc
  tests/generate_reliefs_test.cc
  tests/split_by_plane_test.cc
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
