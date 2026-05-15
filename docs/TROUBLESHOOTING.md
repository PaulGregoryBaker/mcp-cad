# Troubleshooting

## Common Issues

### 1. `cmake-js` Cache Issues
Sometimes, `cmake-js` can lock up or fail to pick up changes in underlying C++ code.
**Solution**: Use `cmake-js rebuild` instead of `cmake-js build` to force cache deletion and re-evaluation. Check the `.dockerignore` to ensure build directories aren't accidentally copied into the node runtime layer during Docker image builds.

### 2. Linking errors (e.g. `relocation R_X86_64_PC32 against symbol`)
When building the N-API Shared Addon (`.node`), the static library `libgeometry_engine.a` might throw a relocation exception.
**Solution**: Ensure that all C++ code in `cpp/src` is built with Position Independent Code enabled in CMake:
```cmake
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
```

### 3. OCCT Memory Issues
OpenCASCADE is a stateful C++ architecture prone to memory leaks if standard handles are dereferenced manually or if topological solids are cached indefinitely.
**Solution**: Always use standard OCCT handles (`Handle(X)`). Do not keep global lists of shapes in memory without proper memory fences or explicit invalidation when the session token expires. Run tests using AddressSanitizer (`-fsanitize=address`) if leaks are suspected.

### 4. VCPKG Build Failures
If `vcpkg` fails during Docker compilation:
- Ensure sufficient Docker memory (>8GB) is available, as compiling OCCT requires significant resources.
- Clear the Docker build cache with `docker builder prune`.
