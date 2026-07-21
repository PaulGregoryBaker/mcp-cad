/**
 * Project-specific ESLint rules enforcing constitution v2.0.0 principles that a
 * generic lint config can't express: V/XIV (central numerical policy — no tolerance
 * literals outside the policy module) and VII (no silent fallbacks — any @fallback
 * code path must cite an ADR).
 *
 * Loaded via eslint-plugin-local-rules (see .eslintrc.json "plugins"/"rules").
 */

// Path (relative to ts/) where tolerance constants are allowed to live once Phase 5
// builds the numerical policy module (rebuild/17-numerical-policy.md). Nothing lives
// there yet, so today every tolerance-shaped literal anywhere is a real finding —
// that's correct, not a bug in the rule.
const POLICY_MODULE_PATH = 'src/geometry/numerical-policy.ts';

// Heuristic for "this literal looks like a tolerance/epsilon", not a proof — small,
// non-integer, non-zero magnitude is what every real tolerance in this codebase's
// history (0.1mm coord-map threshold, 1e-5 boolean fuzz, 0.1-0.2mm kerf) looks like.
// Deliberately conservative: integers and literals >= 1 are assumed to be counts,
// indices, or scale factors, not tolerances, and are left alone to keep noise down.
function looksLikeTolerance(value) {
  return typeof value === 'number' && value !== 0 && Math.abs(value) < 1;
}

const COMPARISON_OPERATORS = new Set(['<', '<=', '>', '>=', '===', '!==', '==', '!=']);

const noToleranceLiteral = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban numeric tolerance/epsilon literals outside the central numerical policy module (constitution v2 principle V/XIV).',
    },
    schema: [],
    messages: {
      inComparison:
        'Tolerance-shaped literal {{value}} used directly in a comparison. Move it into the numerical policy module ({{policyPath}}) as a named, documented constant — constitution v2 principle V.',
      inDeclaration:
        'Tolerance-shaped literal {{value}} assigned to "{{name}}" outside the numerical policy module. This constant belongs in {{policyPath}}, not here — principle V.',
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, '/');
    if (filename.endsWith(POLICY_MODULE_PATH)) {
      return {};
    }
    return {
      BinaryExpression(node) {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (side.type === 'Literal' && looksLikeTolerance(side.value)) {
            context.report({
              node: side,
              messageId: 'inComparison',
              data: { value: String(side.value), policyPath: POLICY_MODULE_PATH },
            });
          }
        }
      },
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'Literal' &&
          looksLikeTolerance(node.init.value) &&
          node.id.type === 'Identifier'
        ) {
          context.report({
            node: node.init,
            messageId: 'inDeclaration',
            data: {
              value: String(node.init.value),
              name: node.id.name,
              policyPath: POLICY_MODULE_PATH,
            },
          });
        }
      },
    };
  },
};

const ADR_REFERENCE_PATTERN = /ADR-\d|rebuild\/\d\d-/;

const fallbackRequiresAdr = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Any @fallback-tagged code path must cite an ADR/design-doc reference in the same comment (constitution v2 principle VII).',
    },
    schema: [],
    messages: {
      missingAdr:
        '@fallback tag with no ADR/design-doc reference nearby. Principle VII requires an explicit, documented decision (e.g. "ADR-3" or "rebuild/19") plus a dedicated correctness test — a fallback without a cited rationale is exactly what this principle prohibits.',
    },
  },
  create(context) {
    return {
      Program() {
        const comments = context.getSourceCode().getAllComments();
        for (const comment of comments) {
          if (/@fallback\b/.test(comment.value) && !ADR_REFERENCE_PATTERN.test(comment.value)) {
            context.report({
              loc: comment.loc,
              messageId: 'missingAdr',
            });
          }
        }
      },
    };
  },
};

module.exports = {
  'no-tolerance-literal': noToleranceLiteral,
  'fallback-requires-adr': fallbackRequiresAdr,
};
