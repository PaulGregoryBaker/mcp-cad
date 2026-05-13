cmake_minimum_required(VERSION 3.26)
project(mcp_cad_geometry VERSION 0.1.0 LANGUAGES CXX)

include(FetchContent)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ─── vcpkg integration ───────────────────────────────────────────────────────
# Expects VCPKG_ROOT or CMAKE_TOOLCHAIN_FILE set externally.
# Fallback: auto-detect from environment variable.
if(DEFINED ENV{VCPKG_ROOT} AND NOT DEFINED CMAKE_TOOLCHAIN_FILE)
  set(CMAKE_TOOLCHAIN_FILE "$ENV{VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"
      CACHE STRING "vcpkg toolchain file")
endif()

# ─── Find packages (via vcpkg) ───────────────────────────────────────────────
# OpenCASCADE's config package expects module components (e.g. FoundationClasses),
# not library names. Loading without components imports all standard modules.
find_package(OpenCASCADE REQUIRED)
find_package(Catch2 3 REQUIRED)

# libnest2d is header-only.
# Resolution order:
#   1) System include paths (e.g. Debian libnest2d-dev)
#   2) Vendored source path
#   3) Fetch from upstream repository
set(LIBNEST2D_GIT_TAG "master" CACHE STRING "Git ref to fetch for libnest2d")
option(MCPCAD_FETCH_LIBNEST2D "Fetch libnest2d from source when not installed" ON)

find_path(LIBNEST2D_INCLUDE_DIR
  NAMES libnest2d/libnest2d.hpp
  PATHS
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libnest2d/include
    ${CMAKE_CURRENT_SOURCE_DIR}/external/libnest2d/include
)

if(NOT LIBNEST2D_INCLUDE_DIR AND MCPCAD_FETCH_LIBNEST2D)
  message(STATUS "libnest2d headers not found locally. Fetching from source (${LIBNEST2D_GIT_TAG})...")
  FetchContent_Declare(libnest2d_src
    GIT_REPOSITORY https://github.com/tamasmeszaros/libnest2d.git
    GIT_TAG        ${LIBNEST2D_GIT_TAG}
    GIT_SHALLOW    TRUE
  )
  # Header-only usage: populate sources without configuring/building upstream CMake project.
  FetchContent_GetProperties(libnest2d_src)
  if(NOT libnest2d_src_POPULATED)
    FetchContent_Populate(libnest2d_src)
  endif()
  set(LIBNEST2D_INCLUDE_DIR "${libnest2d_src_SOURCE_DIR}/include")
endif()

if(NOT LIBNEST2D_INCLUDE_DIR OR NOT EXISTS "${LIBNEST2D_INCLUDE_DIR}/libnest2d/libnest2d.hpp")
  message(FATAL_ERROR "libnest2d headers not found. Install libnest2d-dev, vendor headers under third_party/libnest2d/include, or enable MCPCAD_FETCH_LIBNEST2D.")
endif()

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
    $<$<CONFIG:Debug>:-g -O0>
  )
endif()

# AddressSanitizer support (enabled via cmake -DASAN=ON)
option(ASAN "Enable AddressSanitizer" OFF)
if(ASAN)
  add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address)
endif()

# ─── Geometry Engine Library ─────────────────────────────────────────────────
add_library(geometry_engine STATIC
  src/geometry/geometry_service.cc
  src/geometry/topology_graph.cc
  src/acl/feature_extractor.cc
)

target_include_directories(geometry_engine
  PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/src
  PRIVATE ${LIBNEST2D_INCLUDE_DIR}
)

# Link all OCCT modules exported by this package revision.
target_link_libraries(geometry_engine PUBLIC
  ${OpenCASCADE_LIBRARIES}
)

# ─── NAPI Addon (built separately via cmake-js) ───────────────────────────────
# See src/napi/CMakeLists.txt for addon build.
# Run: cmake-js build from cpp/ directory.

# ─── Test Executable ─────────────────────────────────────────────────────────
add_executable(geometry_tests
  tests/geometry_test.cc
  tests/tab_slot_test.cc
  tests/feature_extractor_test.cc
  tests/ge_integration_test.cc
  tests/ge_decompose_integration_test.cc
)

target_include_directories(geometry_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${LIBNEST2D_INCLUDE_DIR}
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
