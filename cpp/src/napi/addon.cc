/**
 * NAPI addon entry point — registers geometry methods on the module.
 *
 * Task: T042
 */

#include <napi.h>
#include "geometry_binding.cc"  // Include directly for single-TU NAPI build

namespace mcp_cad {

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  RegisterGeometryMethods(env, exports);
  return exports;
}

NODE_API_MODULE(geometry_addon, Init)

}  // namespace mcp_cad
