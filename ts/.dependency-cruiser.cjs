/**
 * Import-boundary rules enforcing constitution v2.0.0 principle I (layered core,
 * one-way dependencies) and the related structural halves of III, IV, and VIII.
 * See .specify/memory/constitution.md and rebuild/19-cpp-ts-interface-boundary.md.
 *
 * v1 (the dispatch-table MCP server under src/mcp, src/manufacturing,
 * src/validation, etc.) has been removed; the layered mcp/domain-core/kernel
 * boundary rules that used to live here applied to that architecture and have
 * been dropped along with it. v2 (src/v2/**) has its own module boundaries
 * (graph/resources/tools/persistence) not yet expressed as depcruise rules.
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
        collapsePattern: '^(node_modules|src/v2/(graph|resources|tools|persistence))/[^/]+',
      },
    },
  },
};
