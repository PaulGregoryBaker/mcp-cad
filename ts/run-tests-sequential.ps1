# run-tests-sequential.ps1
# Runs every test file as its own isolated vitest invocation.
# No cross-file C++ state bleed possible. Reports PASS / FAIL per file.
# Usage: cd ts && pwsh run-tests-sequential.ps1 [--integration-only] [--unit-only]

param(
    [switch]$IntegrationOnly,
    [switch]$UnitOnly
)

Set-Location $PSScriptRoot

# ── File lists (relative to ts/) ────────────────────────────────────────────

$unitFiles = @(
    'tests/manufacturing.test.ts',
    'tests/mcp.test.ts',
    'tests/dxf_orientation.test.ts',
    'tests/dxf_merge.unit.test.ts',
    'tests/dxf_panel_frame_bbox.test.ts',
    'tests/rules.test.ts',
    'tests/bom.test.ts',
    'tests/assembly.test.ts',
    'tests/bend_sequence.test.ts',
    'tests/manufacturability.test.ts',
    'tests/export.test.ts',
    'tests/session.test.ts',
    'tests/config-schema.test.ts',
    'tests/unit/fuse_preflight.unit.test.ts'
)

$contractFiles = @(
    'tests/contracts/architecture-boundaries.contract.test.ts',
    'tests/contracts/decompose.contract.test.ts',
    'tests/contracts/evaluate-manufacturability.contract.test.ts',
    'tests/contracts/mcp-errors.contract.test.ts',
    'tests/contracts/mcp-resources.contract.test.ts',
    'tests/contracts/synthesize-joints.contract.test.ts',
    'tests/contracts/geometry-binding.contract.test.ts',
    'tests/contracts/tools-coverage.contract.test.ts',
    'tests/contracts/apply-unfold.contract.test.ts',
    'tests/contracts/coordinate-map.contract.test.ts'
)

$integrationFiles = @(
    'tests/integration/error_model.integration.test.ts',
    'tests/integration/md_config.integration.test.ts',
    'tests/integration/md_rules.integration.test.ts',
    'tests/integration/md_scoring.integration.test.ts',
    'tests/integration/sys_jtbd_02_safety.integration.test.ts',
    'tests/integration/sys_jtbd_05_rollback.integration.test.ts',
    'tests/integration/assembly.integration.test.ts',
    'tests/integration/direct_edits.integration.test.ts',
    'tests/integration/dolt_smoke.integration.test.ts',
    'tests/integration/interrogation.integration.test.ts',
    'tests/integration/semantic_mapping.integration.test.ts',
    'tests/integration/sew.integration.test.ts',
    'tests/integration/graph-workflow.test.ts',
    'tests/integration/mcp_b.integration.test.ts',
    'tests/integration/multi-part-graph.test.ts',
    'tests/integration/sys_jtbd_01_decompose.integration.test.ts',
    'tests/integration/sys_jtbd_03_unfold_score.integration.test.ts',
    'tests/integration/sys_jtbd_04_export_lifecycle.integration.test.ts',
    'tests/integration/validate_assembly.integration.test.ts',
    'tests/integration/split_by_bends.integration.test.ts',
    'tests/integration/merge_unfold_dxf_content.test.ts',
    'tests/integration/merge_unfold_panel_selection_bug.test.ts',
    'tests/integration/fuse_unfold_graph_regression.test.ts',
    'tests/integration/build_shell_acute_fold.integration.test.ts',
    'tests/integration/merge_protrusion_flat_layout.integration.test.ts',
    'tests/integration/fuse_orientation_preserved.integration.test.ts',
    'tests/integration/merge_edge_alignment.integration.test.ts',
    'tests/integration/split_pipeline_compliance.integration.test.ts',
    'tests/integration/transforms.integration.test.ts',
    'tests/integration/merge_orientation_preserved.integration.test.ts',
    'tests/integration/coordinate_mapping_multibend.integration.test.ts',
    'tests/integration/cube_box_workflow.functional.test.ts',
    'tests/integration/transaction_primitive.integration.test.ts',
    'tests/integration/unfold.integration.test.ts',
    'tests/integration/fuse_y_contact.integration.test.ts',
    'tests/integration/merge_asymmetric_flat.integration.test.ts',
    'tests/integration/merge_tab_bracket.integration.test.ts',
    'tests/integration/unfold_roundtrip.integration.test.ts',
    'tests/integration/fuse_shell_resolution.test.ts',
    'tests/integration/booleans.integration.test.ts'
)

# ── Build the run list ───────────────────────────────────────────────────────

$runs = @()

if (-not $IntegrationOnly) {
    foreach ($f in $unitFiles)     { $runs += [pscustomobject]@{ Project = 'unit';        File = $f } }
    foreach ($f in $contractFiles) { $runs += [pscustomobject]@{ Project = 'contract';    File = $f } }
}

if (-not $UnitOnly) {
    foreach ($f in $integrationFiles) { $runs += [pscustomobject]@{ Project = 'integration'; File = $f } }
}

# ── Run each file individually ───────────────────────────────────────────────

$results  = @()
$total    = $runs.Count
$idx      = 0

foreach ($run in $runs) {
    $idx++
    $label = "$($run.Project)/$($run.File -replace 'tests/','')"
    Write-Host "`n[$idx/$total] $label" -ForegroundColor Cyan

    # Each file gets its own isolated vitest process — no shared C++ state.
    $output = npx vitest run --project $run.Project $run.File --reporter=verbose 2>&1
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        $status = 'PASS'
        Write-Host "  PASS" -ForegroundColor Green
    } else {
        $status = 'FAIL'
        # Print the last ~20 lines so the failure is visible inline
        $lines = $output -split "`n"
        $tail  = $lines | Select-Object -Last 20
        Write-Host ($tail -join "`n") -ForegroundColor Yellow
        Write-Host "  FAIL (exit $exitCode)" -ForegroundColor Red
    }

    $results += [pscustomobject]@{
        Status  = $status
        Project = $run.Project
        File    = $run.File
    }
}

# ── Summary ──────────────────────────────────────────────────────────────────

Write-Host "`n$('─' * 72)" -ForegroundColor DarkGray
Write-Host "RESULTS ($total files)" -ForegroundColor White

$passed = $results | Where-Object Status -eq 'PASS'
$failed = $results | Where-Object Status -eq 'FAIL'

Write-Host ("  PASS: {0}   FAIL: {1}" -f $passed.Count, $failed.Count) -ForegroundColor White

if ($failed.Count -gt 0) {
    Write-Host "`nFAILING FILES:" -ForegroundColor Red
    foreach ($r in $failed) {
        Write-Host ("  [{0}] {1}" -f $r.Project, $r.File) -ForegroundColor Red
    }
}

Write-Host "$('─' * 72)" -ForegroundColor DarkGray
