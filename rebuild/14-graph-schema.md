# 14 — Manufacturing Graph Schema v2 (Phase 2.2)

**Status:** **Reviewed & approved by Paul 2026-07-20** — all §7 open points ratified
(D2.1–D2.6, D2.2a). Restructured through the session around Paul's correction: **the
flat outline belongs to the part, not the region panel** (§0), the panel/region
terminology fully aligned to `region_panel` (§0), the `regionOf`/`boundingBends`
derivation corrected to use a panel's own touching bends rather than a full ancestor
walk (§2.1), and concrete point-array outputs specified (13 §3.3). Propagates into
[13](13-translation-module-design.md) (updated to match throughout).

**Inputs it must satisfy:** the translation model (13 §2/§4), the Dolt store (B7 —
row-per-entity, stable keys, single-edit → minimal diff, AC-B.8), FR-K CRUD (edits are
row edits), FR-I anchors (I3a–d), B5 history (branch/merge/review over these rows),
B2 replay (geometry never stored — the graph is sufficient to regenerate everything).

## 0. The correction: part owns the outline; region panel geometry is derived

**A part is the component before any assembly (Paul, 2026-07-19–20): one continuous
flat blank, cut once, then bent.** Manufacturing reality is cut-first, bend-second —
not "N separately-shaped region panels glued together." The schema now says that directly:

- **`part` owns ONE flat outline** (its cut profile) in **one shared flat frame `F`**.
  There is no per-region-panel frame and no per-region-panel stored outline.
- **`region_panel` is a named, derived region** of that one outline — the area bounded by
  its surrounding bend lines. Its shape is *computed* (clip `F` by the bends that
  directly touch it — §2.1), never stored. Two region panels' shapes can never
  disagree at a shared edge, because there is no second outline for them to disagree
  with.
- **`T_pc` (the old child-to-parent flat placement transform) is deleted.** It existed
  only to place one region panel's separately-defined outline next to another's; with one
  shared frame there is nothing left to place. This is not simplification for its own
  sake — it removes the exact mechanism that had to "agree" at a seam, which was v1's
  entire worst bug class (L1).
- **Assembly happens above the part, never inside it.** Multiple physically-joined
  blanks (welded, riveted) are multiple **parts**, connected by joints (FR-C4) and/or
  documented by cross-part semantic anchors (I3d, §2.2) — never a second outline
  living inside one part's graph. "Part = pre-assembly component" is the line.

**Why the entity is called `region_panel` — not two concepts kept in sync, one name
for one thing.** `[ADDED 2026-07-20 — Paul; naming completed 2026-07-20]` A "region
between bends" in the flat layout and a "panel" in the folded 3D graph were never two
related things requiring synchronization — they are **one graph row, viewed from two
representations**: its flat view is the area of `F` bounded by its own touching bend
hinges (§2.1); its folded view is that same area transformed by its pose chain
(13 §4). The table name `region_panel` says this directly, so the schema itself
cannot drift back into treating them as separate — there is no separate "region"
table, and no plain "panel" table either, only `region_panel`. Anywhere a design or
the semantic layer needs to name "the area between two bends," if that area *is* a
whole region panel's bounding area, the correct reference is simply that
`region_panel` row (I3a) — not a second, parallel description of the same thing
(§2.4 tightens this for I3b, where "region" alone still names a genuinely smaller,
arbitrary area — never this entity).

**Validation, not just tidiness:** this retroactively explains two of v1's worst bugs.
`GE_BUILD_FROM_PATTERN_FAILED: Multi-zone hinge-line splitting not yet implemented`
(found by the suite) is v1 having half-built exactly this model — one flat pattern
split by hinge lines — and never finishing more than one hinge line. "Refold produced
2 solids" and the seam-offset saga (memory) came from boolean-fusing independently
placed region panel bodies back together; under this model there is nothing to fuse, because
the region panels were never separate. Both bug classes become geometrically impossible
rather than something to get right through careful math.

## 1. Principles

1. **Rows are the graph.** Every node/edge is a row (or a small set of rows); there is
   no serialized blob anywhere. A bend-angle edit touches one row; a move-edge touches
   its vertex rows — Dolt diffs then *read as engineering changes* (B5c).
2. **Authoritative vs derived.** Authoritative tables hold only what the translation
   module needs as *input* (the part's one outline, its bend lines, anchor, material).
   Everything derivable (region shapes, poses, chains, flat pattern, drawings, meshes,
   validation findings) lives outside the versioned schema in caches keyed by commit
   hash — discardable by definition (B7). See §3.
3. **Stable identity.** All entity IDs are UUIDs minted once at creation and never
   reused — across sessions, branches, and merges (B6). Ordering within a ring uses
   **fractional order keys**, not sequence renumbering (§4).
4. **The tree is explicit.** Bend rows *are* the tree edges over region panels (named regions);
   root-ness is a part-level fact. Schema constraints enforce tree shape (§5).
5. **One outline per part, not per region panel** `[§0]` — the single most load-bearing rule
   in this schema; every other principle is subordinate to it.
6. **Parts are anchored independently; semantics do the connecting.** See §2.3.

## 2. Authoritative tables

Types: `id` = UUID; lengths mm, angles deg; `d` = double.

```
part            (part_id PK, name,
                 root_region_panel_id FK→region_panel,             -- the fold-tree's root region
                 anchor_r00..r22, anchor_tx,ty,tz,   -- R: embeds F into world (13 §3.1)
                 material_id, thickness_mm d,        -- ONE thickness per part (D3)
                 k_factor d,                         -- from material; per-bend override allowed
                 schema_version,
                 merged_into_part_id FK→part NULL)   -- §2.1.2: mirrors
                                                      -- merged_into_region_panel_id, one level up
                                                      -- (15-mcp-contract.md §4.2, merge_bodies_with_bend)

part_ring       (ring_id PK, part_id FK,             -- OWNED BY PART (§0) — the one flat outline
                 kind ENUM(outline, hole,             -- outline/hole = the cut profile (canonical
                           feature_poly,              -- CCW/CW); feature_poly = a feature's polygon
                           semantic_region))          -- (feature.poly_ring_id); semantic_region = a
                                                      -- STORED, authored I3b sub-region-panel polygon
                                                      -- (semantic_anchor.region_poly_ring_id, §2.4).
                                                      -- Only outline/hole are the single-source
                                                      -- cut geometry (§2.2); the other two kinds
                                                      -- are genuinely authored data — not derived,
                                                      -- not a second copy of anything — so storing
                                                      -- them is correct, same status as
                                                      -- dimension_curation.
                                                      -- coords are in F, the PART's single flat
                                                      -- frame.

ring_vertex     (vertex_id PK, ring_id FK,
                 order_key VARCHAR,                  -- fractional/lexicographic ordering (§4)
                 x d, y d,                           -- in F
                 bulge d DEFAULT 0)                  -- arc segments (smooth_edge K2) — DXF-style bulge

region_panel    (region_panel_id PK, part_id FK, label,
                 k_factor_override d NULL,
                 dirty bool,                         -- regeneration hint only, never truth
                 merged_into_region_panel_id FK→region_panel NULL) -- §2.1.1: set when this region panel's bounding
                                                      -- bend is removed (a MERGE, not a delete —
                                                      -- Paul, 2026-07-20). NULL = live region panel,
                                                      -- eligible as a bend parent/child and as the
                                                      -- target of regionOf(). Non-NULL = alias: the
                                                      -- row persists forever (identity never dies
                                                      -- on merge) but resolves through this
                                                      -- pointer (chain-walked) to find the live
                                                      -- region panel that absorbed its material.
                                                      -- NO outline/ring here (§0) — a LIVE region panel's
                                                      -- shape is F clipped by its own touching
                                                      -- bend hinges (§2.1), computed, never stored.

bend            (bend_id PK, part_id FK,
                 parent_region_panel_id FK, child_region_panel_id FK,
                 hinge_ax d, hinge_ay d, hinge_bx d, hinge_by d,   -- hinge segment, IN F (one frame)
                 angle_deg d,                        -- signed, internal convention D1
                 radius_mm d,
                 k_factor_override d NULL)           -- T_pc is GONE (§0) — nothing to place

seam            (seam_id PK, part_id FK,
                 region_panel_a FK, region_panel_b FK,
                 seg_a_ax..ay..bx..by d,              -- both segments in F (same shared frame —
                 seg_b_ax..ay..bx..by d)              -- no more "region panel-local" per side)

feature         (feature_id PK, part_id FK,          -- OWNED BY PART, not region panel (§0/§2.2)
                 kind ENUM(hole_circle, cutout_poly, slot, notch, relief),
                 cx d NULL, cy d NULL, r d NULL,     -- parametric kinds, in F
                 poly_ring_id FK NULL,               -- polygon kinds reuse part_ring rows
                 process ENUM(laser, punch, tap) NULL)
                                                      -- NO region_panel_id: ownership (which region a
                                                      -- feature falls in) is derived by
                                                      -- point-location, not stored (§2.2).

semantic_entity (sem_id PK, name, kind, description) -- project-level: may span parts (I3d)

semantic_anchor (anchor_id PK, sem_id FK, role,
                 type ENUM(node, region, feature_set),
                 target_kind ENUM(region_panel,bend,feature,seam) NULL, target_id NULL,  -- I3a:
                                                      --   incl. "this whole region panel" — a region panel
                                                      --   IS the region between its bounds
                                                      --   (§0), so whole-region-panel anchors use
                                                      --   THIS, never type=region.
                 region_panel_id FK NULL,            -- I3b: an area strictly smaller than the
                 region_poly_ring_id FK→part_ring)   --   whole region panel; a STORED part_ring row
                                                      --   (kind=semantic_region, §2), in F —
                                                      --   authored/curated data, versioned like
                                                      --   everything else. See §2.4.
                                                      --   (region_bend_a/b REMOVED 2026-07-20 —
                                                      --   "between two bends" now always means
                                                      --   a region panel; see I3a instead.)

anchor_feature  (anchor_id FK, feature_id FK)        -- I3c feature sets (PK both)

dimension_curation (dim_id PK, part_id FK,           -- 07/OPEN-24: drawing curation IS graph data
                 dim_kind, ref_a, ref_b,             -- entity refs the dimension measures
                 promoted bool, hidden bool)

action_log      (seq BIGINT PK AUTO, at TIMESTAMP,
                 actor_kind ENUM(human, agent), actor_id,
                 tool, params JSON,
                 delta_summary JSON)                 -- N12; same store, versioned with the graph

meta            (schema_version, tolerance_profile_id, ...)
```

## 2.1 Region panel identity is stored; only region panel geometry is derived

`[CLARIFIED 2026-07-20 — Paul asked how a derived thing can be anchored persistently]`
**The `region_panel` row itself is ordinary stored data**: a UUID minted once (B6), never
recomputed, never reused — identical in kind to a `bend` row or a `feature` row. A
semantic anchor's `target_id` (I3a) references that stable `region_panel_id`, and that
reference is exactly as durable as any other foreign key in this schema, versioned by
Dolt the same way. **What is never stored is the region panel's *shape*** — its 2D/3D
geometry is computed from the part's one outline (`part_ring`) and the bend lines
that bound it, fresh, every time:

```
boundingBends(p) =
    { bend b : b.child_region_panel_id  = p }        -- p's OWN incoming bend (0 if root, else 1)
  ∪ { bend b : b.parent_region_panel_id = p }         -- p's OWN outgoing bends (0..N, its children)

regionOf(region_panel p) = F
  clipped-by  { for each b in boundingBends(p):
                  p = b.child_region_panel_id  →  keep the CHILD side of hinge(b)   (D1)
                  p = b.parent_region_panel_id →  keep the OTHER side of hinge(b)   -- excludes
                                                                                     -- that child's
                                                                                     -- territory
              }
  minus       { hole rings that fall within the clipped region } -- holes clip the same way
```

`[CORRECTED 2026-07-20 — Paul: "how will we know which region belongs to which part
of the flat panel between bends? This association is not clear."]` An earlier version
of this formula clipped only by *ancestor* hinges, which is wrong for any panel with
more than one bounding bend — a middle panel in a chain, or any panel with its own
children, also needs its **own outgoing bends** excluded (a child's territory is not
part of its parent's region). The corrected formula needs only `p`'s *immediately
touching* bends — **not a tree walk**: querying `bend` by `parent_region_panel_id = p`
or `child_region_panel_id = p` directly returns every bend that bounds `p`, and D1's
existing directed-hinge convention (child always on the left) already says which side
to keep for each. No new stored field is needed — the association was always fully
determined by the existing `parent_region_panel_id`/`child_region_panel_id` columns
plus D1; it just needed both queried, not one walked. This also means merge (§2.1.1)
re-parenting a panel's former children onto the survivor isn't just tree-walk
housekeeping — it is *exactly* what keeps this query correct: the survivor's
`boundingBends` set picks up the absorbed panel's outgoing bends directly.

- This is the multi-line polygon subdivision v1 never finished (§0) — clipping a
  possibly-non-convex outline by a *set* of hinge half-planes. Because each bounding
  bend contributes one half-plane constraint (§0 above), the clip is **order-
  independent** — the result is the same regardless of which bounding bend is applied
  first — which is what makes `boundingBends(p)` a set, not a sequence. This is the
  **core algorithmic requirement** of the translation module (13 §3.2/§4) and must be
  solved once, robustly, for arbitrary N — not per-case.
- **Root region panel** = the one panel never referenced as any bend's
  `child_region_panel_id` (zero incoming bends) — its `boundingBends` set is purely
  its own outgoing bends (if any), same formula as any other panel.
- A region panel with an empty `boundingBends` set (no bend references it at all —
  a part with just one region panel) is just `regionOf(region_panel) = F`.
- **Concrete output form** `[ADDED 2026-07-20]`: `regionOf` isn't an abstract set —
  its value is an ordered 2D point array (outer ring + hole rings). The 3D shape
  built from it is two index-correlated point arrays, bottom and top, offset by the
  part's thickness `t`. Full derivation: 13 §3.3.

### 2.1.1 The semantic graph persists through both splits and merges

`[CORRECTED 2026-07-20 — Paul.]` **Principle, stated directly: the semantic graph
must stay constant across structural edits to the fold tree.** A region's engineering
meaning doesn't change because the geometric model of it got more (or less) detailed
— splitting a region panel or merging two doesn't touch what the material *is*, only how
finely the graph currently subdivides it. An earlier draft of this doc got both
directions of this wrong — treating merge as a destructive delete, and treating
split as leaving the new region panel with no coverage at all. Corrected:

**Merge (a bend is removed) — identity persists via an alias.** The material on both
sides of a removed bend still exists, now as one contiguous region instead of two;
nothing was deleted, so nothing should look deleted. `Q`'s row is **never removed**.
The operation:
1. delete the `bend` row (the fold is genuinely gone);
2. **re-parent** any bend that had `Q` as its `parent_region_panel_id` to `P` instead (so
   the live tree — the one `evaluate()` walks — stays alias-free; §3.2's hot path
   never has to chase pointers);
3. set `Q.merged_into_region_panel_id = P` (`Q` becomes an alias; `P` absorbs the material
   and, by convention, is always the surviving identity — the parent, never the
   child — which also means the **root region panel can never become an alias**: it has no
   parent bend to be the child side of, by construction).

Any reference to `Q` — a semantic anchor's `target_id`, a `dimension_curation` ref,
anything — **resolves transparently** by following `merged_into_region_panel_id`
(chain-walked, for repeated merges) to the live region panel. **No stale-anchor finding is
generated; nothing needs re-anchoring.** The anchor's meaning ("this region") is
still exactly correct — the region just has a bigger owner now.

**Split (a bend is added, creating new child `Q` from part of `P`'s region) — semantic
coverage is copied forward, not left behind.** `Q` is a genuinely new row (there is
nothing pre-existing to alias), so persistence here means *propagating* `P`'s
semantic links onto `Q` at the moment of the split, not silently leaving `Q`
unanchored:
- For every **I3a whole-region-panel anchor** on `P` (`semantic_anchor` with
  `target_kind=region panel, target_id=P`) at split time, the split operation **creates a
  matching anchor on `Q`** too (same `sem_id`, same `role`) — a real, independent
  row, not a reference. Immediately after the split, `P` and `Q` both carry every
  anchor `P` had before it — exactly Paul's "the new part should have the same
  semantic graph links that the other part had." From that point on `P` and `Q` are
  independent rows and may be re-anchored or diverge individually, same as any two
  region panels.
- **I3c feature-set anchors** are unaffected — features aren't region panel-owned (§2.2),
  so a split changes nothing about which feature a feature-set anchor names.
- **I3b sub-region-panel anchors** need a geometric check, not a blind copy: if the
  new hinge line passes through a stored region polygon (`region_poly_ring_id`), the
  polygon's recorded `region_panel_id` may no longer be the region panel that actually
  contains it (`P` or `Q`, geometrically, post-split). This is **flagged, not
  auto-resolved** (K5 philosophy) — a typed finding on the affected `semantic_anchor`
  — but its `recommendedFix` (F4) is simple and safe: repoint `region_panel_id` to
  whichever of `P`/`Q` now actually contains the polygon (or, if the hinge cut
  *through* the polygon itself, flag that the region itself needs redrawing — no
  automatic fix offered for that case, since redrawing requires a judgment call).
- `dimension_curation` is deliberately **not** copied — curation is about specific
  dimensions on the drawing sheet, and a split changes which dimensions exist at all
  (new bend line, new edges); re-curation after a split is a normal follow-up edit,
  not a continuity requirement the way engineering-meaning anchors are.

Symmetry note: merge uses a *pointer* (one row, `Q`, already existed) and split uses
a *copy* (two rows now exist where one did) — the mechanisms differ because the
identity count changes in opposite directions, but the outcome is the same principle
both times: **structural edits to the fold tree never silently lose semantic
coverage.**

### 2.1.2 The same mechanism, one level up: joining two parts

`[ADDED 2026-07-20 — resolves 15-mcp-contract.md OPEN-15.1, Paul: "agree; an already
merged graph can be split with this function."]` `merge_bodies_with_bend` (the tool
that joins two independent parts, per 15 §4.2) is **§2.1.1's merge, generalized one
level up — the same mechanism, not a second one**:

1. Reconcile part `B`'s outline into part `A`'s `F` (13 §6's import-reconciliation
   pattern, reused rather than re-invented) — `B`'s region panels, bends, features,
   and semantic rows are re-parented onto `A`'s `part_id`.
2. **Create the connecting bend via the ordinary `create_node(bend, ...)` call** —
   the exact same operation that performs a within-part split (§2.1.1). There is no
   special "join two parts" primitive underneath the tool; joining *is* create-a-bend,
   just at a seam that used to be two parts' edges instead of one part's interior.
3. `B.merged_into_part_id = A` (mirrors `merged_into_region_panel_id`, §2 above) — `B`
   is never deleted; any reference to it resolves through the alias, same as a merged
   panel; no stale-anchor finding is generated (I3f, same as panel merge).

**Consequence — this is what makes the resulting bend perfectly ordinary**: because
step 2 is a plain `create_node(bend)`, the joined structure is, from that point on,
indistinguishable from a bend that was always internal to one part. "Splitting an
already-merged graph" needs no dedicated undo/unmerge tool — it's the same
`delete_node(bend)`/`create_node(bend)` CRUD as anywhere else in the graph (15 §4.3).
What it does *not* do is automatically resurrect `B` as an independent top-level part
— deleting that bend merges the adjoining region panels (ordinary panel-level merge,
§2.1.1), the same as deleting any other bend. Regenerating a standalone part from a
subtree is a distinct capability nobody has asked for yet; it is not assumed here.

## 2.2 Where the flat outline is stored, and where each thing lives

`[REVISED 2026-07-20]` Two different things used to share the name "outline" per
region panel; now there is only one outline, period, and it belongs to the part:

1. **The outline's SHAPE — stored, authoritative, once per part.** `part_ring`
   (kind=outline) + its `ring_vertex` rows, in `F`. This is the actual cut profile —
   what goes to the laser. Editing it (K2 move-edge/smooth-edge) is editing these rows
   directly, and that is the entirety of what "the outline" means as data. **Region panels do
   not have outlines of their own** (§2.1) — asking "where is region panel P's outline
   stored" no longer has an answer, by design; the answer is "computed from the part's
   one outline, clipped by the bends that directly touch P (§2.1)."
2. **A region panel's PLACEMENT after folding — NOT stored, computed.** Where a region panel's region
   ends up in 3D — the fold applied, its neighbours' folds applied before it — is
   `Pose(p)`, a `Layout` field (§3), produced by `evaluate()` and living only in the
   Layout cache. (There is no more separate 2D "`Flat(p)` placement" step — see §0;
   a region's flat shape is already a subset of `F`, nothing needs positioning in 2D.)

**Why split it this way, deliberately:** this is lesson L1 made into a schema rule,
now doubly so: not only is there one function that derives 3D placement from 2D data
(§3), there is now only **one 2D shape in the first place** — no second outline that a
second routine could derive independently and disagree with. "The flat pattern" (a
DXF export, a drawing's D1 sheet) is always a direct read of `part_ring` — never
assembled from pieces, because it was never pieces.

**Features (§2, `feature` table) are owned by the part, in `F`, for the same reason
outlines are** — not by a region panel. A feature's owning region panel (for drawing-sheet grouping,
UI context) is resolved by point-location against `regionOf` at read time, never stored;
authoring verbs (K2 "add hole to region panel P") accept a region panel reference for ergonomics and
translate it into `F` coordinates immediately — the *stored* fact is only the flat
position.

## 2.3 Part anchors, multi-part scenes, and where assembly lives

Each part's `anchor_*` (the root transform `R`, 13 §3.1) is **independent** — set from
its own import measurement or authoring, with no stored relationship to any other
part's anchor. There is no mate/constraint/assembly table (FR-H is cut).

**"Part = the component before any assembly" (Paul) is now the organizing line of the
whole schema, not just a policy note:** everything in §0–§2.2 makes a part exactly one
flat blank; everything in this section makes clear that connecting blanks is strictly
a cross-part concern:

- **"Connected" is not a new geometric primitive inside a part** — it's the ordinary
  part-level move (`translate_body`/rotate, FR-J), mutating only the target part's
  `anchor_*`. Bringing two independently-built parts into their correct relative
  position *is* an anchor edit on one or both of them; there is no assembly step, and
  critically, **no second-outline escape hatch** — a part can never grow a second
  blank internally as a workaround for needing two connected pieces. Two connected
  pieces are always two parts.
- **Physical joins between parts** (weld, rivet, tab-slot) are FR-C4's joint verbs —
  a *manufacturing* relationship between two independent parts' regions, not a fold
  (a bend requires continuous material by definition; a joint is precisely what's
  used when material is *not* continuous). Joints need their own authoritative table
  once FR-C4 is designed in Phase 2.3 (§7 D2.5 — deferred, not designed here) —
  explicitly reserved as a cross-part, not intra-part, concept.
- **The reason a relative position is correct lives in the semantic graph.** A
  cross-part `semantic_anchor` (I3d — the air-flow-cavity example: a region on part A,
  a region on part B, each with a role) records *why* the parts must sit as they do.
  It documents and validates; it does not move anything.
- **Cross-part validation follows from this**: `check_clearance` (merged gap/
  intersection verb) is **not scoped to a single part** — it evaluates any two placed
  regions in the session, including across parts. A stale/misaligned cross-part
  connection surfaces as an ordinary K5-style typed finding, not a broken constraint.
- **World frame:** all part anchors share one world coordinate system per session —
  implicit and unrecorded, as v1 had one scene. Multiple independent projects are out
  of scope (OPEN-10/B6 durability is about branching one project's history).

## 2.4 Where sub-region-panel semantic areas (I3b) are stored

`[ADDED 2026-07-20]` A whole-region-panel semantic anchor (I3a) needs no stored
geometry — it references `region_panel_id`, and the region panel's shape is read
live (§2.1). But an I3b anchor names something *smaller than a whole region panel* —
an area the designer has drawn,
not a fact derivable from bends — and that polygon is genuinely new information, so
it **is** stored: a `part_ring` row with `kind=semantic_region` (§2), owned by the
part, in `F`, with ordinary `ring_vertex` rows. `semantic_anchor.region_poly_ring_id`
points at it. It versions, diffs, branches, and merges exactly like the outline
(§4) — it is simply a different *kind* of ring, not a different mechanism. If that
polygon's containing region panel is later deleted (§2.1.1), the anchor follows the same
I3e/K6 stale-anchor-then-re-anchor path as an I3a anchor would.

## 3. What is deliberately NOT here — and where it actually lives instead

**The 2D↔3D mapping is not schema. It is not stored anywhere, ever, as data.** It is
*computed* by the translation module (13), a pure function
`evaluate(graphSnapshot, profile) → Layout` — `Layout` now being `{Pose(·), region
shapes}` per part (13 §3.2 — `Flat(·)` is gone as a stored/derived-per-region-panel concept
per §0; region shapes are clips of the one `F`, and 3D pose is still the chain product).

**Where it runs — a fourth architectural layer:**

```
MCP boundary (map_2d_to_3d, get_flat_pattern, get_drawings, …)
        ↓
Application services  ────────────────►  Layout cache (NOT versioned)
        ↓  reads rows for a commit           keyed by (part_id, commit_hash, profile_id)
Graph store (this schema, §2) — Dolt         value = Layout, computed lazily, evicted freely
        ↓  (also feeds evaluate() directly)
Translation module (13): evaluate(graphSnapshot, profile) → Layout
```

- A query resolves the **active checkout's commit hash** (B5e), reads that part's rows
  into a `graphSnapshot`, and asks the cache for `Layout(part_id, commit_hash,
  profile_id)`. Miss → `evaluate()` once, store, serve. Hit → serve directly; a
  commit's rows never change, so its `Layout` is valid forever (eviction only, no
  invalidation). Cache locality/eviction is a Phase 3 stack concern (§7 D2.4 — deferred).
- The **same `Layout`** answers every consumer (mapping tools, part construction,
  drawings, semantic region resolution, validation, nesting/export) — one computation,
  many reads: P3's "single geometric solution," enforced at the runtime-architecture
  level, not just the algorithm level.
- **B7's "geometry generated on demand" and B2's replay invariant are the same
  guarantee stated twice**: replay = re-running `evaluate()` from a serialized graph;
  on-demand construction = running it from the current graph. Same function, same
  purity, different trigger.
- **No geometry results in the schema**: no 3D coordinates outside `part.anchor`; no
  region shapes, no chains, no DXF text, no meshes, no drawings — all `Layout` reads,
  cached, never versioned.
- **No validation findings** as authoritative rows: findings (K5 conflicts, seam
  residual violations, stale anchors I3e) are computed from a `Layout` plus the active
  tolerance profile, `recommendedFix` attached (F4), cached the same way. A working
  graph's flagged-inconsistent state is derivable at any commit — review (B5c)
  recomputes it for both sides rather than trusting stored flags.
- **No per-region-panel world transforms** — only the part root has an anchor; region
  panel poses are `Layout` reads (chain products, 13 §4). No column exists for
  per-region-panel world
  state to drift from the graph, and no cache entry can drift either, since `Layout`
  is a pure function of immutable committed rows.
- **No transaction tables** — B5d: the uncommitted Dolt working set IS the
  transaction. An uncommitted graph still evaluates (the cache key uses a content hash
  of the working rows instead of a commit hash).

### 3.1 Cache lifecycle — three layers, three different eviction triggers

`[ADDED 2026-07-20 — Paul: "let's talk about the lifecycle of the mesh/B-Rep — when
is the memory for them removed."]` "The mesh/B-Rep" turns out to span three distinct
memory lifecycles, each with a different owner and a different reason to expire.
**Policy** (what triggers eviction, at what granularity) is decided here, now,
independent of stack; **mechanism** (in-process LRU vs. an external cache tier,
actual size budgets/TTL durations) stays deferred to Phase 3 (§7 D2.4) — those are
tuning numbers that depend on the chosen stack's real memory behaviour, and N13's CI
soak gate is what validates them once chosen.

**Layer 1 — native kernel handles (N13).** Not a cache at all, by design. Because
the translation module is pure (13) and never holds a persistent native shape, a
native handle exists only transiently, scoped to one request: import/decompose
(measuring pieces, 13 §6) or an actual boolean kernel call (`fuse_bodies`,
boolean-mode `cut_panel`, 15 §4.2). Acquired, used, released, within that one call —
never cached, never held across requests. N13's acquire/release discipline is the
entire policy; there is nothing here that accumulates, so nothing here to evict.

**Layer 2 — the `Layout` cache** (above), keyed by `(part_id, commit_hash,
profile_id)` or, for uncommitted state, `(part_id, contentHash, profile_id)`. Two
different entry types, two different triggers:
- **Commit-keyed entries** have no natural expiry moment — an old commit might be
  revisited for history or a B5c diff at any time — so these are pure LRU under a
  size budget (a hard ceiling, chosen in Phase 3, is what N13's soak gate checks).
- **Working-set-keyed entries expire *eagerly*, on the very next edit.** The instant
  the graph changes, the previous content hash becomes permanently unreachable —
  nothing will ever request that exact key again (undo/rollback, B5d, discards the
  working set; it does not time-travel through prior content hashes). These entries
  should be dropped immediately on write, not left for LRU pressure to find later —
  an event-driven trigger, not a usage-driven one.

**Layer 3 — the geometry blob cache** (mesh/boundary/flat-pattern/drawings, served
as a `Ref`, 15 §3.0/§3.3), keyed by `(part_id, commit_or_content_hash, profile_id,
resource_type, resolution/params)`. This layer is downstream of Layout — derived
from it, one step further from the source of truth — and behaves differently enough
to want its own policy:
- The key space is much wider (a UI panning/zooming a viewport over one session may
  request many different `resolution` values for the same commit) and entries are
  much larger (a fine mesh can be MBs; `Layout`'s point arrays are comparatively
  small), so **TTL is the primary driver here** — `Ref.expiresAt` (15 §3.0) is a real
  deadline, not a decoration. A specific resolution requested once for a transient
  zoom level is unlikely to be asked for again with identical parameters; regenerating
  it on a later miss is cheap precisely because its source `Layout` is still
  Layer-2-cached.
- A size-budget backstop still applies underneath the TTL, for whatever's still hot
  (repeatedly re-requested) when its TTL would otherwise fire.

**The invariant that makes all three layers safe to evict aggressively:** every
byte in Layers 2 and 3 is a pure function of the immutable graph (B2/B7). Eviction
never loses data — worst case is recomputation cost, never a correctness gap. This is
a structural departure from v1, where ephemeral 3D state could be the *only* copy of
a fact; here, there is never a copy that matters more than the graph rows it was
computed from.

## 4. Diff & merge behavior (the B7 payoff, by construction)

- Bend angle 90°→87°: **1 row, 1 column** diff on `bend`. Review renders it as
  exactly that engineering change.
- move_edge (K2): updates the `x,y` of the edited vertices in the part's **one**
  `ring_vertex` set — no other rows touched, regardless of which region panel(s) border that
  edge. **Fractional `order_key`** (lexicographic midpoint insertion) means inserting
  a vertex *inserts one row* without renumbering neighbours (§7 D2.1 — decided).
- smooth_edge (K2): replaces a run of vertices (delete + insert rows with `bulge`
  arcs) — the diff shows the redrawn span only.
- Merge conflicts happen at row granularity (two branches editing the same bend angle,
  or overlapping spans of the same outline) — exactly where an engineering review
  wants to adjudicate them; disjoint edits (different bends, different outline spans,
  different parts) merge cleanly by construction. `[Consequence of §0]`: because the
  outline is now one shared set of rows per part rather than N independent sets, two
  edits on *different areas* of the same part's outline still merge cleanly (disjoint
  vertex spans); only edits to the *same* vertices conflict — which is exactly the
  correct granularity, since those are the same physical material.
- **Region panel merge** (§2.1.1 — removing a bend): 1 `bend` row deleted, `k` bend rows
  re-parented (1 column each), 1 column set on the absorbed region panel
  (`merged_into_region_panel_id`) — a handful of small, precisely-attributed row changes,
  never a rewrite of every anchor/curation row that happened to reference the
  absorbed region panel. Those rows are untouched by the merge, which is the point: the
  diff shows exactly what changed (the tree structure), not a wave of unrelated
  identity churn.

## 5. Integrity invariants (schema-enforced where possible)

- **Tree shape:** `bend.child_region_panel_id` UNIQUE per part (≤1 parent per region panel);
  `root_region_panel_id` has no bend row pointing at it; acyclicity checked at write.
- **A bend has exactly two sides, one region panel each** `[ADDED 2026-07-20 — Paul:
  "a bend by definition can only have two children, one on either side of the
  bend"]`: `bend.parent_region_panel_id` and `bend.child_region_panel_id` are both
  required (neither NULL) and must **differ**
  (`parent_region_panel_id ≠ child_region_panel_id`) — a bend divides the outline
  into precisely two regions, never zero, one, or the same panel counted twice. This
  is per-bend-row and orthogonal to the `UNIQUE` rule above: a single region panel
  may still be the parent of many *different* bends (branching fold trees, C14) —
  this constrains what one bend row itself must look like, not how many bends may
  reference a given panel.
- **Live-region-panel-only tree membership** `[ADDED 2026-07-20]`: `bend.parent_region_panel_id`
  and `bend.child_region_panel_id` must reference a **live** region panel
  (`merged_into_region_panel_id IS NULL`) — an aliased region panel can never re-enter the tree.
  `root_region_panel_id` is always live (guaranteed structurally, §2.1.1: only a bend's
  child side can become an alias, and the root has no parent bend).
- **Alias chain is acyclic and terminates**: `merged_into_region_panel_id` may not create a
  cycle (checked at write, same class of check as tree acyclicity) and must resolve
  to a live region panel in a bounded number of hops.
- **Winding:** the part's outline ring is CCW, holes CW — canonicalized at write time
  (the module never re-canonicalizes; 12-domain-notes §2).
- **Referential integrity with explicit cascade** (K1/AC-I.2) — for **true deletes
  only** (material actually removed from the part, §2.1.1): deleting a region panel
  referenced by anchors requires a cascade choice; deleting outline/feature rows that
  a region panel's region depends on likewise. FKs make silent orphaning impossible. **A
  merge (bend removal) is not this case** — it never deletes a region panel row, only a
  bend row, so it needs no cascade choice for anything referencing the region panel.
- **One thickness per part** (`part.thickness_mm`, D3); per-bend/per-region-panel
  `k_factor_override` is the only material-parameter override.
- **Hinge-on-material:** a bend's hinge segment must lie within the part's flat
  outline (not "on the parent region panel" — there is no separate parent shape to be on;
  it must simply be material) within ε (validation finding otherwise, not a write
  block — K5 philosophy).

## 6. History, migration, replay

- **Branch/commit/merge/diff** = Dolt operations on these tables (B5a–c); the action
  log rides along, so review shows *who did what* next to *what changed*.
- **Migration** (OPEN-15/B5e): `meta.schema_version` per branch; migrate-on-checkout;
  compare/merge across schema versions refuses with a typed error until both sides
  are aligned.
- **Replay** (B2/AC-B.1): `evaluate(read(tables), profile)` is the entire regeneration
  path. The replay harness serializes → re-reads → compares layouts; nothing outside
  these tables can influence the result because nothing else exists.

## 7. Decisions (formerly "Open points" — all ratified by Paul, 2026-07-20)

- **D2.1 — DECIDED: fractional order keys.** Ring vertices use fractional
  (lexicographic-midpoint) `order_key`s, not integer sequence + renumbering — an
  insertion is one new row, not a renumbering of every neighbour, which is what keeps
  Dolt diffs small and readable (§4).
- **D2.2 — DECIDED: rolled sections materialize as bend rows.** No separate `roll`
  grouping table that generates a bend chain at evaluation time. A rolled section is
  authored as an ordinary sequence of `bend` rows (each a small-angle increment of
  the roll), keeping the translation module's input uniform — it only ever consumes
  bend rows, never a second bend-producing mechanism. `[OPEN-D2.2a]` if rolled
  sections need bulk edit ergonomics (e.g., "change this roll's total angle" as one
  action across N bend rows), that's a Phase 2.3 verb-design concern (a compound
  MCP tool over many rows), not a schema concern — the rows themselves stay simple.
- **D2.3 — DECIDED: `_curation` / `_annotation` suffix convention.** Extending the
  pattern `dimension_curation` already set: any future table holding authored
  *view*-level metadata (not geometry-authoritative, not derivable, but also not a
  first-class engineering entity in its own right) is named `<subject>_curation` or
  `<subject>_annotation` — e.g., a future drawing-sheet-layout table would be
  `sheet_curation`, not `sheet` or `sheet_layout`. The suffix alone signals "derived
  view + authored overrides," distinguishing it on sight from entity-noun tables
  (`part`, `region_panel`, `bend`, `feature`) without needing a separate registry.
- **D2.4 — PARTIALLY RESOLVED 2026-07-20 (§3.1).** *Policy* is now decided: three
  cache layers (native handles / `Layout` / geometry blobs), each with its own
  eviction trigger (scope-bound / LRU+eager-drop-on-edit / TTL+size-budget) — see
  §3.1 for the full reasoning. *Mechanism* — in-process LRU vs. an external cache
  tier, actual size budgets and TTL durations — remains a Phase 3 stack-selection
  concern, correctly deferred: those are tuning numbers, not design questions.
- **D2.5 — DECIDED: explicitly deferred to Phase 2.3.** The joint table
  (weld/rivet/tab-slot, FR-C4) is a cross-part concept (§2.3) whose exact data needs
  follow from the joint verbs' contract design — ratified as deferred, not designed
  by omission.
- **D2.6 — DECIDED: explicitly deferred to a dedicated implementation-notes pass,
  spec already corrected this session.** The multi-line outline-clipping algorithm
  (§2.1) remains the hardest single piece of the translation module — v1 never
  finished the N>1 case — but its *conceptual* specification is now settled and
  correct: `boundingBends(p)`, order-independent half-plane clipping by a panel's own
  touching bends only (§2.1, corrected 2026-07-20). What's deferred is the robust
  *computational-geometry implementation* (arbitrary non-convex outlines, holes,
  degenerate/sliver cases) against that now-fixed spec — an implementation task, not
  an open design question.
