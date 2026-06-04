# Quickstart: Assembly Validation (009)

This guide outlines how to verify the new Assembly Validation feature and its autofix recommendation engine.

---

## Build & Verify Command Sequence

Follow these steps to build and verify the implementation:

```bash
# 1. Compile C++ Addon (from repository root)
cd cpp
cmake --build build --config Release

# 2. Re-build NAPI addon bindings
napi-build (or npm run build inside ts/)
cd ../ts
npm run build

# 3. Run Validation Tests
# Runs Vitest unit and integration suites
npm test tests/integration/validate_assembly.integration.test.ts
```

---

## Smoke Test Verification Sequence

You can test the tool manually through your MCP client interface with the following JSON payload sequence:

### Step 1: Run validation on clean assembly
Call `validate_assembly` with default arguments:
```json
{}
```
*Expected Response*:
```json
{
  "valid": true,
  "errors": [],
  "summary": {
    "total_parts_checked": 12,
    "rule_count": 2,
    "execution_time_ms": 150
  }
}
```

### Step 2: Run validation with clash error
Simulate a physical overlap between parts:
```json
{
  "part_ids": ["panel_A", "panel_B"]
}
```
*Expected Response (showing the clash warning & autofix suggestion)*:
```json
{
  "valid": false,
  "errors": [
    {
      "id": "err-clash-01",
      "category": "clash_detection",
      "severity": "error",
      "message": "Physical overlap detected between adjacent parts panel_A and panel_B",
      "affected_part_ids": ["panel_A", "panel_B"],
      "autofix": {
        "tool_name": "trim_body_with_plane",
        "arguments": {
          "part_id": "panel_B",
          "keep_positive_side": true
        }
      }
    }
  ],
  "summary": {
    "total_parts_checked": 2,
    "rule_count": 2,
    "execution_time_ms": 45
  }
}
```
