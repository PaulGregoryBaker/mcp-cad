cmake_minimum_required(VERSION 3.26)
project(geometry_addon)

# cmake-js provides Node.js headers and NAPI framework
include_directories(${CMAKE_JS_INC})

# Source files
add_library(geometry_addon SHARED
  addon.cc
)

set_target_properties(geometry_addon PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# cmake-js libraries and definitions
target_link_libraries(geometry_addon PRIVATE
  ${CMAKE_JS_LIB}
  geometry_engine  # Our C++ geometry library (from parent CMakeLists.txt)
)

target_include_directories(geometry_addon PRIVATE
  ${CMAKE_JS_INC}
  ${CMAKE_CURRENT_SOURCE_DIR}/..
  ${node-addon-api_SOURCE_DIR}
)

target_compile_definitions(geometry_addon PRIVATE
  NAPI_VERSION=9
  NODE_ADDON_API_DISABLE_DEPRECATED
)

# ─── Auto-deploy to TypeScript server directory after build ──────────────────
add_custom_command(TARGET geometry_addon POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    $<TARGET_FILE:geometry_addon>
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../ts/geometry_addon.node"
  COMMENT "Deploying geometry_addon.node to ts/"
)
