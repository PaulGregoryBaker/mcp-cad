#!/usr/bin/env node
// Enforces field-level sync between C++ structs that cross the NAPI boundary
// (cpp/src/napi/translation_binding.cc) and their TS mirror interfaces
// (ts/src/geometry/types.ts). Nothing else currently checks this — a field
// silently dropped from one side (e.g. added to the C++ struct and its
// Write function, but never added to the TS interface) is a runtime bug
// with no compile-time signal on either side of the boundary.
//
// No OpenAPI/schema-validation equivalent exists for this because NAPI is
// an in-process native call, not a wire protocol — this is a static check
// over the source text itself instead, same approach as this repo's own
// check-include-boundaries.mjs.
//
// Scope (v1): cpp/src/napi/translation_binding.cc only — the newer v2
// boundary. cpp/src/napi/geometry_binding.cc (the older, larger v1-era
// binding file) is NOT covered yet; a real follow-up, not forgotten.
//
// Also v1: four structs (BendSpec, CircleHoleSpec, RegionPanelLayout,
// BridgeLayout) are read back from JS only as inline code inside a PARENT
// function's loop (e.g. BendSpec fields inside ReadPartGraphSpec's bend
// loop), not a standalone ReadX function this script can isolate by
// regex — those four get write-side checking only (REGISTRY entries with
// readFn: null). Still catches "set going out to JS, but TS doesn't know
// about it" — the actual shape of the bug this tool exists for.
//
// Usage: node cpp/tools/check-napi-field-sync.mjs

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CPP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const NAPI_FILE = join(CPP_ROOT, 'src', 'napi', 'translation_binding.cc');
const TS_TYPES_FILE = join(REPO_ROOT, 'ts', 'src', 'geometry', 'types.ts');

const H = (...parts) => join(CPP_ROOT, 'src', 'geometry', ...parts);

// ─── The registry — the deliberate list of what this script checks ─────────
// Adding a new NAPI-crossing struct means adding a deliberate entry here.
const REGISTRY = [
  { cppStruct: 'Point2', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiPoint2', writeFn: 'WritePoint2', readFn: 'ReadPoint2' },
  { cppStruct: 'Point3', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiPoint3', writeFn: 'WritePoint3', readFn: 'ReadPoint3' },
  { cppStruct: 'Transform3', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiTransform3', writeFn: 'WriteTransform3', readFn: 'ReadTransform3' },
  { cppStruct: 'BendSpec', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiBendSpec', writeFn: 'WriteBendSpec', readFn: null },
  { cppStruct: 'PartGraphSpec', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiPartGraphSpec', writeFn: 'WritePartGraphSpec', readFn: 'ReadPartGraphSpec' },
  { cppStruct: 'CircleHoleSpec', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiCircleHole', writeFn: 'WriteCircleHoleSpec', readFn: null },
  { cppStruct: 'PanelPieceSpec', cppHeader: H('translation', 'step_reconciliation.hpp'), tsInterface: 'NapiPanelPieceSpec', writeFn: null, readFn: 'ReadPanelPieceSpec' },
  { cppStruct: 'RegionPanelLayout', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiRegionPanelLayout', writeFn: 'WriteRegionPanelLayout', readFn: null },
  { cppStruct: 'BridgeLayout', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'NapiBridgeLayout', writeFn: 'WriteBridgeLayout', readFn: null },
  // errorCode is round-tripped as a plain string on the JS side by design,
  // never parsed back into the enum (constructPartSolid never reads it) —
  // see WriteEvaluateResult/ReadEvaluateResult's own comment.
  { cppStruct: 'EvaluateResult', cppHeader: H('translation', 'manufacturing_graph_evaluator.hpp'), tsInterface: 'EvaluatePartGraphResult', writeFn: 'WriteEvaluateResult', readFn: 'ReadEvaluateResult', skipRead: ['errorCode'] },
  { cppStruct: 'MapToWorldResult', cppHeader: H('translation', 'point_mapping.hpp'), tsInterface: 'MapToWorldResult', writeFn: 'WriteMapToWorldResult', readFn: null },
  { cppStruct: 'MapToFlatResult', cppHeader: H('translation', 'point_mapping.hpp'), tsInterface: 'MapToFlatResult', writeFn: 'WriteMapToFlatResult', readFn: null },
  { cppStruct: 'ReconcileOutlinesResult', cppHeader: H('translation', 'part_merge.hpp'), tsInterface: 'ReconcileOutlinesResult', writeFn: 'WriteReconcileOutlinesResult', readFn: null },
  { cppStruct: 'ReconcilePiecesResult', cppHeader: H('translation', 'step_reconciliation.hpp'), tsInterface: 'ReconcilePiecesResult', writeFn: 'WriteReconcilePiecesResult', readFn: null },
  { cppStruct: 'PolygonBooleanResult', cppHeader: H('translation', 'polygon_boolean.hpp'), tsInterface: 'PolygonBooleanResult', writeFn: 'WritePolygonBooleanResult', readFn: null },
  { cppStruct: 'CutPanelResult', cppHeader: H('translation', 'cut_panel.hpp'), tsInterface: 'CutPanelResult', writeFn: 'WriteCutPanelResult', readFn: null },
  { cppStruct: 'Finding', cppHeader: H('validation', 'findings.hpp'), tsInterface: 'NapiFinding', writeFn: 'WriteFinding', readFn: null },
  // ManufacturingProfile is NOT registered: the C++ struct is flat
  // (minBendRadiusFactor, ... as top-level members) but NapiManufacturingProfile
  // nests the same fields under `rules: {...}` — a genuine reshape, not a 1:1
  // mirror, which this script's simple flat-field matcher isn't built to
  // verify without producing permanent, misleading violations. A real check
  // for this one would need field-path (not just field-name) matching.
];

// ─── Text prep ───────────────────────────────────────────────────────────────
// Two parallel, LENGTH-PRESERVING views of each file (comments/strings become
// same-length runs of spaces, newlines untouched) so an index found in one is
// valid in the other:
//  - `extraction`: comments blanked, STRING CONTENT KEPT — this is what field/
//    wire-key regexes run against (they need to see e.g. "radiusMm").
//  - `braceMatch`: extraction, with string content ALSO blanked — this is what
//    brace-depth counting runs against, so a literal '{'/'}' inside a string
//    (none exist in today's covered functions, but don't assume) can't fool it.

function stripComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

function stripStringContents(text) {
  return text.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(m.length - 2)}"`);
}

function prepare(raw) {
  const extraction = stripComments(raw);
  const braceMatch = stripStringContents(extraction);
  return { extraction, braceMatch };
}

// ─── Brace-block extraction ─────────────────────────────────────────────────

/** Given `braceMatch`-view text and the index of an opening '{', returns the
 * index one past its matching '}'. */
function matchBrace(braceMatchText, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < braceMatchText.length; i++) {
    if (braceMatchText[i] === '{') depth++;
    else if (braceMatchText[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Finds `struct <name> {` (possibly with trailing base-class/attribute
 * noise before '{') and returns the block body (real content, exclusive of
 * the braces), or null if not found. */
function findStructBody({ extraction, braceMatch }, structName) {
  const re = new RegExp(`\\bstruct\\s+${structName}\\b[^{;]*\\{`);
  const m = re.exec(braceMatch);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchBrace(braceMatch, openIdx);
  if (closeIdx === -1) return null;
  return extraction.slice(openIdx + 1, closeIdx - 1);
}

/** Finds a top-level (column-0) function DEFINITION line containing
 * `<returnType> <fnName>(` — distinguishes a definition from a call-site
 * expression, which is never at column 0 in this file's style. */
function findFunctionBody({ extraction, braceMatch }, fnName) {
  const re = new RegExp(`^\\S[^\\n]*\\b${fnName}\\s*\\([^\\n]*$`, 'm');
  const m = re.exec(braceMatch);
  if (!m) return null;
  const openIdx = braceMatch.indexOf('{', m.index);
  if (openIdx === -1) return null;
  const closeIdx = matchBrace(braceMatch, openIdx);
  if (closeIdx === -1) return null;
  return {
    signature: extraction.slice(m.index, openIdx),
    body: extraction.slice(openIdx + 1, closeIdx - 1),
  };
}

function findTsInterfaceBody({ extraction, braceMatch }, interfaceName) {
  const re = new RegExp(`\\binterface\\s+${interfaceName}\\b[^{]*\\{`);
  const m = re.exec(braceMatch);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = matchBrace(braceMatch, openIdx);
  if (closeIdx === -1) return null;
  return extraction.slice(openIdx + 1, closeIdx - 1);
}

// ─── Field extraction ────────────────────────────────────────────────────────

/** One simple member declaration per line: `Type name;` / `Type name = x;`
 * / `Type name[9] = {...};`. Skips method declarations (`Point3 Apply(...)
 * const;`, `static Transform3 Identity();`) — anything containing '(' is a
 * function, never a plain data member in this codebase's style. Returns
 * the field names, in declared order. */
function extractCppFields(body) {
  const fields = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.endsWith(';') || line.includes('(')) continue;
    const beforeEq = line.split('=')[0].replace(/;\s*$/, '').trim();
    const m = /(\w+)(\[\d+\])?$/.exec(beforeEq);
    if (m) fields.push(m[1]);
  }
  return fields;
}

/** `<varName>.Set("key", ...)` / `<varName>.Get("key")` occurrences —
 * restricted to ONE js variable name (the function's own top-level object,
 * never a nested sub-object built inline within the same function body,
 * e.g. PartGraphSpec's `outline`/`anchor` sub-objects, or Finding's
 * `anchors`/`recommendedFix` entries) so a nested object's OWN keys don't
 * leak into the parent struct's key-set. The wire-key string is always the
 * canonical field name in this file (confirmed by reading every function
 * this script covers) — no need to trace back through which C++ member
 * produced it. */
function extractWireKeys(body, method, varName) {
  const re = new RegExp(`\\b${varName}\\.${method}\\(\\s*"(\\w+)"`, 'g');
  const keys = new Set();
  let m;
  while ((m = re.exec(body)) !== null) keys.add(m[1]);
  return [...keys];
}

/** The JS object variable a Write function builds and returns — the first
 * `Napi::Object <name> = Napi::Object::New(env)` in its body. */
function findWriteVarName(body) {
  const m = /\bNapi::Object\s+(\w+)\s*=\s*Napi::Object::New\(/.exec(body);
  return m ? m[1] : null;
}

/** The JS object parameter a Read function consumes — from its own
 * signature, `const Napi::Object& <name>`. */
function findReadVarName(signatureLine) {
  const m = /const\s+Napi::Object\s*&\s*(\w+)/.exec(signatureLine);
  return m ? m[1] : null;
}

/** One `name: type;` / `name?: type;` property per line. */
function extractTsFields(body) {
  const fields = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const m = /^(\w+)\??\s*:/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const fileCache = new Map();
  const preparedOf = (path) => {
    if (!fileCache.has(path)) fileCache.set(path, prepare(readFileSync(path, 'utf8')));
    return fileCache.get(path);
  };

  const napiPrepared = preparedOf(NAPI_FILE);
  const tsPrepared = preparedOf(TS_TYPES_FILE);

  const violations = []; // { entry, kind, field }
  const hardErrors = [];

  for (const entry of REGISTRY) {
    const cppPrepared = preparedOf(entry.cppHeader);
    const cppBody = findStructBody(cppPrepared, entry.cppStruct);
    if (cppBody === null) {
      hardErrors.push(`struct ${entry.cppStruct} not found in ${relative(REPO_ROOT, entry.cppHeader)}`);
      continue;
    }
    const tsBody = findTsInterfaceBody(tsPrepared, entry.tsInterface);
    if (tsBody === null) {
      hardErrors.push(`interface ${entry.tsInterface} not found in ${relative(REPO_ROOT, TS_TYPES_FILE)}`);
      continue;
    }
    const cppFields = new Set(extractCppFields(cppBody));
    const tsFields = new Set(extractTsFields(tsBody));
    const napiKeys = new Set();

    for (const [fnName, method] of [[entry.writeFn, 'Set'], [entry.readFn, 'Get']]) {
      if (!fnName) continue;
      const fn = findFunctionBody(napiPrepared, fnName);
      if (fn === null) {
        hardErrors.push(`function ${fnName} not found in ${relative(REPO_ROOT, NAPI_FILE)} (registry entry: ${entry.cppStruct})`);
        continue;
      }
      const varName = method === 'Set' ? findWriteVarName(fn.body) : findReadVarName(fn.signature);
      if (!varName) {
        hardErrors.push(`could not determine the top-level object variable for ${fnName} in ${relative(REPO_ROOT, NAPI_FILE)}`);
        continue;
      }
      const keys = new Set(extractWireKeys(fn.body, method, varName));
      for (const k of keys) napiKeys.add(k);
      const skip = (method === 'Set' ? entry.skipWrite : entry.skipRead) ?? [];

      for (const f of cppFields) {
        if (!keys.has(f) && !skip.includes(f)) {
          violations.push({ entry, kind: `${entry.cppStruct}.${f} never reaches ${method === 'Set' ? 'JS' : 'C++'} (missing from ${fnName})` });
        }
      }
      for (const k of keys) {
        if (!cppFields.has(k)) {
          violations.push({ entry, kind: `${fnName} references "${k}", which is not a field of ${entry.cppStruct} (stale/typo?)` });
        }
      }
    }

    for (const k of napiKeys) {
      if (!tsFields.has(k)) {
        violations.push({ entry, kind: `"${k}" crosses the NAPI boundary but ${entry.tsInterface} has no matching field` });
      }
    }
    for (const f of tsFields) {
      if (!napiKeys.has(f)) {
        violations.push({ entry, kind: `${entry.tsInterface}.${f} has no corresponding NAPI key in ${entry.writeFn ?? '(no writeFn)'}/${entry.readFn ?? '(no readFn)'}` });
      }
    }
  }

  if (hardErrors.length > 0) {
    console.error(`${hardErrors.length} registry entr${hardErrors.length === 1 ? 'y' : 'ies'} could not be resolved (a rename?):\n`);
    for (const e of hardErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`Found ${violations.length} NAPI field-sync issue(s):\n`);
    for (const v of violations) {
      console.error(`  [${v.entry.cppStruct} <-> ${v.entry.tsInterface}] ${v.kind}`);
    }
    process.exit(1);
  }

  console.log(`OK: ${REGISTRY.length} NAPI-crossing struct(s) are field-in-sync with their TS mirror.`);
}

main();
