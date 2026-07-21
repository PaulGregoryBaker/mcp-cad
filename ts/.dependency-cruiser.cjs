/**
 * Import-boundary rules enforcing constitution v2.0.0 principle I (layered core,
 * one-way dependencies) and the related structural halves of III, IV, and VIII.
 * See .specify/memory/constitution.md and rebuild/19-cpp-ts-interface-boundary.md.
 *
 * What this file CANNOT catch (documented so nobody assumes it's covered):
 * - Whether a file actually computes geometry inline (principle IV's deeper claim)
 *   rather than just importing something suspicious — that needs code review, or a
 *   pattern-based rule watching for math operators near coordinate-shaped types.
 * - The dynamic `require(pathTo(".node"))` in geometry/binding.ts — dependency-cruiser
 *   tracks static import/require graphs; a fully dynamic path doesn't resolve to a
 *   graph edge. Enforced instead by the no-restricted-syntax ESLint rule
 *   (see .eslintrc.json) banning the literal string "geometry_addon.node" outside
 *   geometry/binding.ts.
 */
module.exports = {
  forbidden: [
    {
      name: 'mcp-boundary-is-outermost',
      comment:
        'MCP boundary (protocol, dispatch, handlers) sits outermost per principle I. ' +
        'Nothing else may depend on it — that is the "one way" in one-way dependencies. ' +
        'src/index.ts is exempt: it is the composition root (principle VIII) and its ' +
        'entire job is wiring the MCP layer up, which is a different thing from a ' +
        'domain/adapter module reaching sideways into it.',
      severity: 'error',
      from: {
        pathNot: '^src/(mcp|index\\.ts$)',
      },
      to: {
        path: '^src/mcp',
      },
    },
    {
      name: 'domain-core-no-mcp-dependency',
      comment:
        'Domain core (manufacturing graph, validation rules) has zero dependencies on ' +
        'the MCP layer — principle I. Restates the rule above scoped to domain core ' +
        'specifically, so the violation message is clearer when it fires there.',
      severity: 'error',
      from: {
        path: '^src/(manufacturing|validation)',
      },
      to: {
        path: '^src/mcp',
      },
    },
    {
      name: 'domain-core-no-direct-kernel-import',
      comment:
        'Domain core may depend on the GeometryKernel adapter\'s exported port ' +
        'functions (that is the whole point of a port), but must not reach past the ' +
        'adapter into raw NAPI/kernel internals. Today the adapter only exposes ' +
        'binding.ts, jobs.ts, session.ts, types.ts as its public surface; nothing in ' +
        'geometry/ is private/internal yet, so this rule currently has no matching ' +
        'target — it exists so that if an internal-only kernel module is added later ' +
        '(e.g. geometry/internal/*), this rule catches domain core reaching into it ' +
        'immediately rather than after the fact.',
      severity: 'error',
      from: {
        path: '^src/(manufacturing|validation)',
      },
      to: {
        path: '^src/geometry/internal',
      },
    },
    {
      name: 'no-orphan-modules',
      comment: 'Warn on modules nothing imports — dead code left behind by refactors.',
      severity: 'warn',
      from: { orphan: true },
      to: {},
    },
    {
      name: 'no-circular',
      comment:
        'Circular dependencies make the one-way layering in principle I unverifiable ' +
        'by inspection — a cycle can hide a reverse-direction edge.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      archi: {
        collapsePattern:
          '^(node_modules|src/mcp/handlers|src/manufacturing/graph|src/manufacturing/dxf|src/validation/rules)/[^/]+',
      },
    },
  },
};
