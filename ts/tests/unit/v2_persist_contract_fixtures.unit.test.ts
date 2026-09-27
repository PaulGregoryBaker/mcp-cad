/**
 * Contract fixtures (spec 010, T026): every valid sample passes the Zod
 * schema (and, for graph snapshots, the invariants); every invalid sample
 * fails at its declared layer with its declared code. The Form·AI·tion client
 * runs the mirror-image test over the same files.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validatePersisted, type PersistedKind } from '../../src/v2/schemas/persistence';
import { checkGraphInvariants } from '../../src/v2/graph/invariants';
import type { PartGraphSnapshot } from '../../src/v2/graph/store';

const ROOT = path.resolve(__dirname, '..', '..', 'contract-fixtures', 'persistence');
const read = (p: string): unknown => JSON.parse(fs.readFileSync(p, 'utf8'));

const kinds = fs.existsSync(ROOT) ? (fs.readdirSync(ROOT) as PersistedKind[]) : [];

describe('[persist] contract fixtures', () => {
  it('exist (run `npm run schemas:export`)', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(6);
  });

  for (const kind of kinds) {
    const dir = path.join(ROOT, kind);
    it(`${kind}: schema.json present`, () => {
      expect(fs.existsSync(path.join(dir, 'schema.json'))).toBe(true);
    });
    for (const f of fs.readdirSync(path.join(dir, 'valid'))) {
      it(`${kind}: valid/${f}`, () => {
        const doc = read(path.join(dir, 'valid', f));
        const r = validatePersisted(kind, doc);
        expect(r.ok ? [] : r.issues).toEqual([]);
        if (kind === 'part_graph_snapshot') expect(checkGraphInvariants(doc as PartGraphSnapshot)).toEqual([]);
      });
    }
    for (const f of fs.readdirSync(path.join(dir, 'invalid')).filter((n) => !n.endsWith('.expect.json'))) {
      it(`${kind}: invalid/${f}`, () => {
        const doc = read(path.join(dir, 'invalid', f));
        const expectFile = read(path.join(dir, 'invalid', f.replace(/\.json$/, '.expect.json'))) as { layer: string; code: string };
        const r = validatePersisted(kind, doc);
        if (expectFile.layer === 'shape') {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.issues.some((i) => i.startsWith(expectFile.code))).toBe(true);
        } else {
          expect(r.ok).toBe(true);
          const codes = checkGraphInvariants(doc as PartGraphSnapshot).map((v) => v.code);
          expect(codes).toContain(expectFile.code);
        }
      });
    }
  }
});
