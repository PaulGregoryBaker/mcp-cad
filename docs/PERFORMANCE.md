# System Performance Benchmarks

Below are baseline benchmark references for the INF-03 canonical 3-panel sheet metal fixture under normal execution conditions (x64-linux environments).

| Operation | Target Expectation (ms) | Baseline Recorded (ms) | Notes |
|---|---|---|---|
| **System Cold Start** | < 2000 | ~1500 | Node + N-API loading |
| **STEP Import** | < 500 | ~420 | Dependent on mesh granularity |
| **Volume Decomposition** | < 1000 | ~750 | Shell separation and gap calculation |
| **Joint Synthesis** | < 800 | ~400 | Identifying intersecting boundaries |
| **Unfolding** | < 300 / part | ~210 / part | OCCT feature extraction & flattening |
| **Nesting Simulation** | < 1500 | ~690 | Shelf-Next-Fit bin packing |
| **DXF Export** | < 400 | ~250 | |

*Note: Total latency for standard operations usually remains comfortably under the 30.0s requirement specified in the System Integrity contract.*
