# OpenMC geometry interop

The builder imports OpenMC `geometry.xml` / `model.xml` into an editable scene
and exports scenes back to OpenMC XML. This note records how OpenMC concepts
map onto the scene model, the conventions verified against OpenMC's source,
and where lattices plug in.

## Mapping

| OpenMC | Scene |
|---|---|
| `<surface>` | `scene.surfaces` (shared by id; editing one updates every user) |
| half-space `-3` / `3` | `halfspace` node `{ surface: 3, sense: "-" \| "+" }` |
| intersection / `\|` / `~` | `intersect` / `union` / `complement` nodes |
| `<cell>` | `cell` node: ≤ 1 region child + `fill` + fill transform |
| `material="1"` / `"void"` / list | `fill: { type: "material", material: "1" }` (text kept verbatim) |
| `fill="5"` (universe) | `fill: { type: "universe", universe: <universe node id> }` |
| `fill="11"` (lattice / DAGMC) | `fill: { type: "lattice" \| "external", id: 11 }` — placeholder |
| universe (cells sharing `universe=`) | `universe` node in `scene.universes`; the root universe's cells are `scene.roots` |
| a region reused by several cells (`~fuel.region`) | `ref` node `{ target: <node id> }` pointing at the shared region node |
| `<lattice>`, `<hex_lattice>`, `<dagmc_universe>` | kept verbatim in `scene.openmc.preserved`, written back unchanged |
| other `model.xml` sections | kept in `scene.openmc.model.sections`, written back around the new `<geometry>` |
| `temperature`, `density`, `volume` | `cell.openmc.extra`, written back unchanged |

Builder primitives (cube, sphere, …) can appear anywhere a region can. On
export they become their exact analytic surfaces; top-level shapes that are not
cells become void cells.

## Composite surfaces

OpenMC's composite surfaces (`openmc.model.CylinderSector`, `HexagonalPrism`,
`Polygon`, …) exist only in its Python API: each creates several primitive
surfaces and defines `-composite` as a region over them, and `geometry.xml`
only ever contains the primitives. In Critica a composite is a parametric
`composite` node:

```js
{ kind: "composite", params: { type: "hexagonal-prism", sense: "-", values: { edge_length, orientation, … } } }
```

`examples/openmc/composite.js` expands it on demand into private surfaces and
a region (`expandComposite`). Rendering, point location and export all go
through that expansion, so editing a parameter regenerates everything. The
`+` side is the complement, which matches OpenMC's default `__pos__`.

- All 13 types are supported: CylinderSector, IsogonalOctagon,
  RightCircularCylinder (with fillets), RectangularParallelepiped,
  OrthogonalBox, X/Y/ZConeOneSided, Polygon, CruciformPrism, RectangularPrism,
  HexagonalPrism, ConicalFrustum and Vessel.
- Constructions follow `openmc/model/surface_composite.py` literally,
  including `Plane.from_points` normals, the y-axis normal flips, and which
  component surfaces take the boundary condition (never the disambiguation
  planes of one-sided cones and vessels). Periodic pairs of rectangular and
  hexagonal prisms are exported with `periodic_surface_id`.
- **Polygon** decomposes the outline into convex pieces with ear clipping and
  Hertel–Mehlhorn merging, where OpenMC uses scipy's constrained Delaunay
  triangulation. The pieces can differ but the region is the same. Each edge
  maps to a surface as in `Polygon._get_convex_hull_surfs` (planes, z-planes,
  z-cylinders, or one-sided z-cones for the `rz` basis). Self-intersecting
  outlines are rejected like OpenMC does.
- *Expand to half-spaces* (`Scene.expandCompositeNode`) replaces a composite
  with ordinary half-space and operation nodes on new shared surfaces.
- Importing XML cannot recover composites, because the file holds only their
  primitive surfaces.

`js-tests/composite.test.mjs` ports the point-membership checks of OpenMC's
`tests/unit_tests/test_surface_composite.py`. `js-tests/composite-scene.test.mjs`
checks rendering against point sampling, export → import equivalence
(including `+` sides and transforms), and expansion equivalence for every
type.

## Materials

`examples/materials/material.js` mirrors `openmc.Material`:

- **Format.** `materials.xml` holds only nuclides (`<nuclide name ao|wo>`),
  `<density value units>`, `<sab name fraction>`, `<isotropic>`,
  `<macroscopic>` and the `cfg`, `temperature`, `volume` and `depletable`
  attributes. OpenMC's C++ reader rejects `<element>`: elements exist only in
  the Python API, which expands them before writing. Critica does the same on
  export.
- **Expansion** ports `Element.expand` without a `cross_sections.xml`:
  every naturally occurring isotope is used. With a library configured, the
  Python API may instead substitute natural nuclides such as `C0` or fold
  O17/O18 into O16. Uranium enrichment uses the ORNL/CSD/TM-244 correlation
  (U234 and U236 at 0.89 % and 0.46 % of U235 by weight); other elements need
  exactly two natural isotopes.
- **Densities** port `get_nuclide_atom_densities` and `average_molar_mass`.
  With units `sum`, atom fractions are absolute atom/b-cm and weight fractions
  are absolute g/cm³ (the C++ reader's meaning).
- **Import** regroups nuclide lists that exactly reproduce a natural
  composition (relative tolerance 1e-9) back into elements. Repeated nuclides
  are kept as written, since OpenMC adds them up, and flagged with a warning.
  For example, `icsbep/pu-met-fast-044/case-1` lists Pu240 twice.
- **Data** comes from OpenMC's `openmc/data` (natural abundances, AME2020
  masses, `_THERMAL_NAMES`, `material_libraries/pnnl_v2.json`), extracted by
  `tools/gen_nuclear_data.py`.

`js-tests/materials.test.mjs` checks expansion, enrichment, density units,
validation and formulas. It also imports, validates and re-exports all 1484
materials of the 409 `materials.xml` files in `knowledge/benchmarks`,
comparing each nuclide with the original, and builds all 411 PNNL materials.

## Conventions (checked against the OpenMC source)

- **Half-space membership** (`openmc.Halfspace.__contains__`): a point
  exactly on a surface belongs to the positive side (`f ≥ 0`).
- **Region precedence** (`src/cell.cpp`, `Region::Region`): parentheses,
  complement, intersection, union. `~` binds to the next half-space or group.
- **Fill rotation** (`src/cell.cpp:48`, `src/geometry.cpp:222`): OpenMC maps
  world → local with `M·(p − t)`, where `M` is the documented matrix evaluated
  at the *negated* angles. The universe therefore moves by
  `Mᵀ = Rx(φ)·Ry(θ)·Rz(ψ)`: rotate about Z, then Y, then X. Cell transforms use
  `order: "zyx"` for this; builder nodes default to `"xyz"`. A 9-value
  `rotation` is `M` itself (row-major) and is converted to angles on import.
  `js-tests/openmc-core.test.mjs` checks the matrix, and
  `examples/openmc/locate.js` implements point location literally as the C++
  does, which the tests compare against the mesh evaluator.
- **Torus coefficients** (`src/surface.cpp`, missing from the docs):
  `x0 y0 z0 A B C`, with major radius `A`, half-width `B` along the axis, and
  `C` radially (an elliptical tube).
- **Rect lattice universes** (`src/lattice.cpp:224`): rows are listed from the
  highest y down, z layers from the bottom up, and each element's universe has
  its origin at the element centre.

## Evaluation

- **World box.** Half-spaces are infinite, so they are built inside a world
  box: explicit, or (by default) the range of all finite bound values of the
  root items per axis. Axes nothing bounds (2D models) get the largest finite
  span. See `Scene.resolveWorld`.
- **Inverted values.** Each region node evaluates to `{ solid, inverted }`,
  where inverted means "everything except `solid`". The outside of a cylinder
  or a complement is never meshed as a world-sized solid unless it has to be
  displayed. `A ∩ ~B` becomes `A − B`.
- **Memo.** Every solid is created through a memo keyed by structure: node
  data, transform, and the clipping box. Edits recompute only what changed,
  undo is free, and identical keys share solids.

## Export

- Surfaces are converted to algebraic forms (a plane, a 4×4 quadric matrix, or
  a torus). Node transforms are applied exactly (`Q' = M⁻ᵀ Q M⁻¹`) and the
  result is simplified back to the most specific OpenMC type (`fromForm`). A
  scaled sphere becomes a `quadric`, a rotated `y-cylinder` a `z-cylinder`.
- Tori must stay axis-aligned with a circular radial section; anything else is
  an error (OpenMC has no general torus).
- Duplicate surfaces are merged by rounded coefficients. Untransformed
  imported surfaces keep their ids and boundary conditions.
- Overlaps: earlier top-level items win over later ones where they overlap,
  but only for pairs involving a non-cell shape (imported cells are assumed
  disjoint, as OpenMC requires).
- A vacuum world box and an `outside` void cell are added when no exported
  surface has a boundary condition.

## Lattices: extension points

The design keeps these decisions open so lattices slot in without rework:

1. **Fill targets are nodes in `scene.universes`.** OpenMC lattice and
   universe ids share one namespace, and so does this list. A `lattice` node
   (`params: { lowerLeft, pitch, dimension, universes, outer }`) goes there,
   and cells reference it with `fill: { type: "universe", universe: <node id> }`.
   `Scene.canContain`, `detach` (reference cleanup) and the exporter's
   reachability walk need a lattice case.
2. **Universe evaluation is parameterized by a local clip box.**
   `Evaluator.#fillParts` maps the cell region's bounds into the fill frame and
   calls `#universeParts(target, ctx)` with that box. A lattice evaluates each
   element universe with the element box (`pitch`-sized, centred at the
   origin), which is identical for every element. The memo therefore builds
   each distinct universe once, and only the translations and the final clip
   to the cell region differ per element.
3. **Parts carry the owning cell id** (`part.tag`), so lattice instances keep
   per-cell colours and picking without extra bookkeeping.
4. **Preserved XML** already round-trips lattices. Modelling them means
   replacing the preserved element with a node and generating the element on
   export (`exportOpenMC`, which already computes reachability through
   lattices).
5. **Point location** (`locate.js`) needs the lattice index lookup
   (`src/lattice.cpp:339`) to validate lattice rendering with the existing
   Monte Carlo tests.

Performance to watch: a 17×17 assembly is ~289 element instances, each a
transform plus an intersection with the element box. Skipping the clip when an
instance's bounds lie inside its element box will matter.

## Tests

- `js-tests/openmc-core.test.mjs`: XML, region parser/formatter, surface
  forms, transforms, simplification, quadric classification, rotation
  convention, and a parse sweep over OpenMC's own test inputs.
- `js-tests/openmc-io.test.mjs`: exact volumes (`complex_cell`), a rotated
  universe fill against point location, `model.xml` round trip, builder-shape
  export, and import → export → import of every corpus file compared point by
  point. Mesh volumes are compared with Monte Carlo point location for each
  corpus model without lattices; models with overlapping cells are skipped.

The corpus tests read `knowledge/openmc/tests/` and are skipped when that
checkout is absent.
