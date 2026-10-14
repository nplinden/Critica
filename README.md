Note that this project is vibecoded.

# Critica

Constructive solid geometry (CSG) in WebAssembly. A dependency-free Rust core
compiled to a ~65 KB `.wasm`, with a small hand-written ES module wrapper.

```js
import { init } from "critica";

const geo = await init();

const body = geo.cube().intersect(geo.sphere({ radius: 1.35 }));
const rod = geo.cylinder({ radius: 0.6, start: [0, -2, 0], end: [0, 2, 0] });
const part = body.subtract(rod, rod.rotateX(90), rod.rotateZ(90));

const { positions, normals, indices, tags } = part.toMesh(); // GPU-ready buffers
const stl = part.toSTL();                                     // binary STL bytes
console.log(part.volume, part.bounds, part.triangleCount);
```

## API

**Primitives** (all Y-up): `cube({ center, radius | size })`,
`sphere({ center, radius, slices, stacks })`,
`cylinder({ start, end, radius, radiusEnd, slices })`,
`cone({ start, end, radius, slices })`,
`torus({ center, major, minor, segments, rings })`,
`fromMesh(positions, indices)` for closed, CCW-wound triangle meshes.

**Booleans**: `a.union(...)`, `a.subtract(...)`, `a.intersect(...)`,
`geo.union(...)`, `geo.intersect(...)`, `a.inverse()`. They take any number
of operands or arrays of operands.

**Transforms**: `translate`, `rotate(axis, degrees)`, `rotateX/Y/Z`, `scale`,
`mirror("x" | "y" | "z")`, `transform(mat4)` (column-major, e.g. three.js
`Matrix4.elements`).

**Tags**: `solid.tag(n)` labels polygons. The labels survive booleans and are
exported per vertex in `toMesh().tags`, so you can color or assign materials
by source solid.

**Queries**: `volume`, `surfaceArea`, `bounds`, `polygonCount`,
`triangleCount`, `isEmpty`.

Solids are immutable: every operation returns a new `Solid`. Each one lives in
wasm memory until you call `dispose()` (or `using` with explicit resource
management). A `FinalizationRegistry` also frees solids that the JS garbage
collector reclaims.

## Building

Requires Rust (the toolchain and `wasm32-unknown-unknown` target are pinned in
`rust-toolchain.toml`) and Node ≥ 18.

```sh
npm run build   # → pkg/critica.wasm
npm test        # Rust unit tests + JS tests against the built wasm
npm run demo    # builder at http://localhost:1948/
```

### Builder GUI

`examples/index.html` is a point-and-click modeller:

- **Ribbon**: the *Geometry* and *Materials* tabs at the top each have a
  ribbon of tools (collapsible with ▴ or a double-click on the tab). The
  *Geometry* ribbon groups the tools: *Surfaces* adds a bare OpenMC surface
  (no region yet): *Plane ▾* (X, Y, Z or arbitrary), *Sphere*, infinite
  *Cylinder ▾* (X, Y, Z), and *Others ▾* for infinite cones and tori (X, Y, Z);
  *Shapes* adds finite regions: *Cube*, *Sphere*, *Cylinder*, and *Others ▾*
  for a cone and OpenMC's composite surfaces; *Combine* has Union, Subtract, Intersect, Complement,
  Ungroup, Duplicate and Reference; *View* has Cutaway, the By material, Void,
  World box, Isolate, X-ray, Grid (the grid plane; <kbd>G</kbd>) and Axes
  (the X/Y/Z axis lines; <kbd>A</kbd>) toggles, and Fit; *OpenMC → Preview XML* opens
  the geometry.xml, materials.xml or model.xml that *Export as* would write
  (with its warnings), to copy or download. The *Materials* ribbon has
  New, From library, Duplicate and Delete. When one operation, cell or universe is selected,
  new nodes go inside it.
- **Top bar**: a *File* menu (New, Open… <kbd>Ctrl+O</kbd>, Save
  <kbd>Ctrl+S</kbd>, Export as → OpenMC XML…), *Preferences* (light/dark theme or follow the OS, viewport statistics, adaptive tessellation,
  world box, curved-surface tessellation, up axis), and *Help* (Tutorial…, Keyboard shortcuts…
  <kbd>?</kbd>).
- **Scene tree**: shows the CSG tree. Subtract children are badged *base* or
  *cut*, and leaf icons use the same color as the faces they produce.
  Ctrl-click selects several nodes; the numbers show selection order, and the
  first selected becomes the Subtract base. Drag rows to reorder or reparent
  them. *Duplicate* (<kbd>Ctrl+D</kbd>) makes an independent copy: copied
  half-spaces get their own surfaces, so editing the copy leaves the original
  alone (use *Reference* to keep them linked). The ● toggle excludes a node
  from its parent without deleting it; a
  disabled top-level shape is just hidden, and references (↪) to a disabled
  node still use it.
- **Surfaces**: the *Surfaces* section under the tree lists every surface of
  the scene, used or not (unused ones are not exported; <kbd>Del</kbd> deletes
  them). Double-click a surface (or <kbd>F2</kbd>, or *Rename…* in its
  right-click menu) to rename it in place; the name is exported and shown in
  generated half-space names. Drag surfaces (or *Move up*/*Move down* in their right-click menu)
  to reorder them: the ids follow the new order (the same set of ids is
  reassigned, so imported ids stay in use) and every half-space, periodic
  partner and generated name is updated. *Half-space* (above the tree, next to *Cell* and *Universe*) adds a
  half-space on the selected surface, inside the operation or cell selected
  just before, if any; several half-spaces can share a surface. Right-click a
  surface (in the tree or the viewport) to create its − or + half-space
  directly, keep it shown, or delete it. The ▸ of a
  leaf (half-space, shape or composite) lists the surfaces it is made of; a
  shape's generated surface becomes an editable copy when used by *Half-space*.
  Click a surface to select the surface itself: it is drawn
  as a surface, not a half-space (a sheet for planes, a translucent shell for
  spheres, cylinders, cones, tori and quadrics, visible through solids) with
  small red + signs on its positive side and blue − signs on its negative
  side (each sign is seen from its own side only), and
  clicking it in the viewport selects it again. Shared surfaces are edited in
  place (for every half-space using them); surfaces generated by a shape are
  read-only. The ◉ toggle (or *Keep shown*) keeps a surface drawn.
- **Shared regions**: a region can be used by several cells, as in OpenMC
  (`water.region = box & ~fuel.region`). Combining a free shape with a region
  that already belongs to a cell inserts a reference (↪) to it, not a move:
  the cell keeps its region and both uses stay in sync. The *Reference* tool
  (<kbd>R</kbd>) adds references explicitly; a reference can be turned into an
  independent copy. Exports write the shared surfaces once.
- **Flatten**: right-click a shape (cube, sphere, cylinder, cone) in the tree or the
  viewport, or use the button in its properties, to replace it by the
  intersection of the half-spaces it is made of, on scene surfaces, with its
  transform applied (a cube becomes six planes, a sphere one sphere half-space). Identical surfaces already
  in the scene are reused, so adjacent shapes share their planes, and the
  node keeps its id, so references to it still work. Right-click also offers
  Rename, Duplicate and Delete.
- **Properties**: shape parameters and position, rotation and scale for any
  node, plus the triangle count, volume and size of the selected node's
  result. With several nodes selected (Ctrl-click), edits apply to every
  selected node of the same type as the last one clicked (same composite type
  for composites): select three spheres and set the radius to change all three.
  Fields whose values differ show *mixed*; names and OpenMC ids stay per node.
- **Viewport**: click a face to select the whole region it belongs to (the
  top-level item or cell); click again inside the selection to step one level
  down toward the shape or half-space that produced the face, or Alt-click to
  go straight to it. Selected nodes that are hidden,
  such as subtracted cutters, are drawn as an x-ray ghost. *Isolate* shows
  only the selection.
- Keyboard: <kbd>Ctrl+Z</kbd>/<kbd>Ctrl+Y</kbd> undo/redo, <kbd>Del</kbd>
  delete, <kbd>Ctrl+D</kbd> duplicate, <kbd>U</kbd>/<kbd>S</kbd>/<kbd>N</kbd>/<kbd>C</kbd>
  (union/subtract/intersect/complement), <kbd>F</kbd> fit,
  <kbd>I</kbd> isolate, <kbd>X</kbd> x-ray, <kbd>V</kbd> show void cells,
  <kbd>W</kbd> show the world box as a wireframe (*World*; black, light grey
  on the dark theme),
  <kbd>M</kbd> color by material (with a legend) instead of by cell.
- **Cutaway** (<kbd>K</kbd>): slice the view with a section plane along X/Y/Z,
  remove a quarter around an axis, or remove an eighth (one octant), with
  position sliders. Cut solids show flat
  section faces in their colors, and clicking selects the cells inside. It is a
  display effect only: the geometry is not modified.
  The scene autosaves to `localStorage`.

The scene model and evaluator (`examples/scene.js`) don't depend on the DOM.
Each node's result is cached by a structural key, so editing a shape only
recomputes that node and its ancestors, and undo is instant.

### OpenMC geometry

*File → Open…* (or drag and drop) an OpenMC `geometry.xml` or `model.xml` to edit it.
*File → Export as → OpenMC XML…* exports the scene back.

- Imported models are fully editable. Each cell's region becomes a tree of
  half-space, intersect, union and complement nodes. Surfaces are shared:
  editing one updates every cell that uses it, or use *Use a private copy* to
  edit one use only. Cells show their material or universe fill, and
  universes are listed under the tree.
- New OpenMC geometry can be built directly: *Surfaces* (ribbon) adds a surface
  (its type can be changed to any OpenMC type, with boundary conditions), *Half-space*
  (above the scene tree) makes a region from one side of it, *Cell* wraps a region into a
  cell with a material or universe fill, and *Universe* adds a universe.
  Builder primitives can be mixed in; they export as exact analytic surfaces.
- *Shapes → Others ▾* (ribbon) adds any of OpenMC's composite surfaces
  (cylinder sector, hexagonal and rectangular prisms with rounded corners,
  polygon, vessel, …) as one parametric node with an inside/outside side.
  A selected cylinder sector shows construction lines inside its hole
  (r < inner radius): its axis and the spokes from the axis to its two
  edges. They export as the primitive surfaces OpenMC would generate, and
  *Expand to half-spaces* turns one into editable half-spaces.
- Infinite half-spaces are drawn inside a world box, auto-fitted to the
  bounded content (or set manually in *Preferences*). Faces that only exist
  because the world box cuts an unbounded region (the four sides of a slab
  between two planes, the ends of an infinite cylinder) are drawn faded with
  diagonal stripes: the region goes on past them. A plane half-space shown on
  its own is drawn as a sheet with arrows pointing into the kept side.
  OpenMC models display Z-up.
- Not displayed yet: lattices and DAGMC universes. They are kept verbatim and
  written back on export, and cells filled with them are drawn as grey
  placeholders.

### Materials

The **Materials** tab edits the material library that cells reference by id
(the `material="…"` of OpenMC cells).

- Materials hold nuclides and natural elements (optionally enriched, using
  OpenMC's uranium correlation or two-isotope enrichment), in atom or weight
  fractions, with any OpenMC density unit (`g/cm3`, `kg/m3`, `atom/b-cm`,
  `atom/cm3`, `sum`), S(α,β) tables, temperature, volume,
  depletable flag and isotropic nuclides. Macroscopic (multigroup) data and
  NCrystal `cfg` are not supported: on import, such materials come in empty or
  without their `cfg`, with a warning.
- *From library* (Materials ribbon) adds any of the 411 reference materials of the PNNL compendium
  (PNNL-15870 Rev. 2) that OpenMC bundles; *+ Formula* adds a chemical formula.
- A live summary shows mass and atom densities, molar mass, element and
  nuclide breakdowns, validation errors, the cells using the material, and the
  exact XML. The arithmetic ports `openmc.Material` (densities) and
  `openmc.Element.expand` (natural expansion and enrichment).
- Elements are expanded into natural isotopes on export, as the Python API
  does. Imported nuclide lists that reproduce a natural composition are shown
  as elements again.
- *File → Open* a `materials.xml` adds its materials; *File → Export as* writes
  `materials.xml`, `geometry.xml`, or a `model.xml` with both (plus the
  settings and tallies of an opened `model.xml`).

Nuclear data (natural abundances, AME2020 masses, thermal table names) and the
PNNL library are generated from an OpenMC checkout with `npm run gen:data`
(`tools/gen_nuclear_data.py`).

### Sources

The **Source** tab edits the external source distributions written into
OpenMC's `<settings>` (`openmc.IndependentSource`). The geometry viewport is
shown alongside, with each source drawn as a pink wireframe (the selected one
highlighted); *View → Sources* draws them in the Geometry tab too.

- *Add source*: *Point*, *Box*, *Sphere*, *Cylinder* (uniform in the volume,
  as `openmc.stats.spherical_uniform` / `cylindrical_uniform`), and
  *Others ▾ → Cartesian*. New sources are centred on the world box.
- Each source has a particle type, a relative strength, and space, angle,
  energy and time distributions. Space: point, box (optionally fissionable
  sites only), spherical (r, cos θ, φ), cylindrical (r, φ, z) or cartesian
  (x, y, z). Angle: isotropic, monodirectional or μ/φ. Distributions:
  discrete, uniform, power law, Maxwell, Watt, normal and tabular, with energy
  presets (Watt fission, 14.1 MeV D-T, 2.45 MeV D-D, Maxwell). Energies are in
  eV; the default is OpenMC's Watt spectrum.
- *Constraints*: domains (cell, material or universe ids), fissionable only,
  energy and time windows, and the rejection strategy.
- A live summary validates the source and shows its exact XML.
- *File → Open* a `model.xml` or a `settings.xml` to edit its sources; the rest
  of the settings is kept and the sources are written back in place on
  export (*Export as → settings.xml* or *model.xml*, also in *Preview XML*).
  File, compiled, mesh and tokamak sources, and distributions Critica does
  not edit (mixtures, decay spectra, biased sampling, mesh and point-cloud
  spaces), are kept verbatim.

### Simulation settings

The **Settings** tab edits the rest of OpenMC's `<settings>`, grouped in cards:

- **Run**: run mode, particles, batches, inactive batches and generations per
  batch (eigenvalue), seed, energy mode (and max scattering order in
  multi-group).
- **Convergence**: the k-eff trigger (type and threshold) and tally triggers
  (on, max batches, check interval).
- **Physics**: photon transport and electron treatment, survival biasing,
  fission and delayed neutrons, weight cutoff and survivor weight, neutron and
  photon energy cutoffs, neutron time cutoff.
- **Temperature**: default, method, tolerance, multipole and range.
- **Output**: `summary.h5` and `tallies.out`, output path, state point and
  source point batches and options, verbosity, lost-particle limits.

The ribbon sets the run mode (*Eigenvalue*, *Fixed source*, *Others ▾*:
volume, plot, particle restart), *Reset*s to the defaults of a new scene
(eigenvalue, 1000 particles, 100 batches, 10 inactive), and previews
`settings.xml`. Empty fields mean OpenMC's default and write nothing; fields
that do not apply to the run mode are hidden and not written. A summary
validates the settings (missing particles or batches, inactive ≥ batches, a
trigger without threshold, a fixed source run without sources, …) and shows
the `settings.xml` that would be exported. Settings of an opened file that the
tab does not list (meshes, weight windows, entropy, …) are kept and written
back. The top bar's former *Settings* button is now *Preferences*.

See [docs/openmc.md](docs/openmc.md) for the mapping, the conventions checked
against OpenMC's source, and the extension points planned for lattices.

### Script playground

`examples/playground.html` (not linked from the builder; open it directly at
`/examples/playground.html`) is a live editor. You write JS against `geo`,
return a solid, then orbit it in WebGL and download it as STL.

## Deployment

The app is static files (pages, JS modules and the wasm), so any web server
works. The `Dockerfile` builds the wasm in a Rust stage and serves everything
with an unprivileged nginx (`deploy/nginx.conf`: gzip, correct
`application/wasm` type, revalidating caches, `/` → `/examples/`).

```sh
docker build -t critica .
docker run -d --name critica -p 1948:1948 --restart unless-stopped critica
# → http://<server>:1948/
```

A GitHub Actions workflow (`.github/workflows/docker.yml`) runs the tests and
publishes a multi-arch image (amd64, arm64) to the GitHub Container Registry
on every push to `main` (`latest`, `sha-…`) and on `v*` tags (`1.2.3`, `1.2`):

```sh
docker run -d --name critica -p 1948:1948 --restart unless-stopped ghcr.io/<owner>/<repo>:latest
```

New GHCR packages are private: make the package public in its settings, or
`docker login ghcr.io` on the server with a token that can read packages.

Or with Compose:

```yaml
services:
  critica:
    build: .
    ports: ["1948:1948"]
    restart: unless-stopped
```

For HTTPS, put it behind your reverse proxy (Caddy, Traefik, nginx) and
forward to port 1948; redirects are relative, so no extra configuration is
needed. Everything runs in the visitor's browser: the server stores nothing,
and scenes stay in each user's browser storage. The pages load the Ubuntu font
from Google Fonts.

## How it works

- **Algorithm**: the BSP-tree boolean scheme from Evan Wallace's csg.js. Both
  operands are compiled into BSP trees, each tree clips the other's polygons,
  and the surviving polygons are merged. The BSP lives in an arena and every
  traversal is a loop rather than recursion. Convex inputs degenerate into
  chains as deep as their polygon count, and a recursive version would
  overflow the wasm stack on high-resolution spheres.
- **Nested surfaces**: booleans are quadratic in the polygon count on convex
  operands, and most OpenMC models are nested shells. The evaluator keeps the
  analytic form of each half-space (sphere, axis cylinder, axis box) and skips
  booleans where boundaries cannot cross: a spherical shell is the outer
  sphere merged with the inner one inverted, and a coaxial annulus cut by
  planes is generated directly with the cylinders' own vertices (`geo.tube`,
  `solid.merge`). Other operands are then applied with the general booleans.
  On the 378 drawable ICSBEP models this makes the first evaluation 9.5×
  faster (Godiva: 1.5 s → 7 ms), with the same solids.
- **Adaptive tessellation**: the *Segments* preference applies to surfaces as
  large as half the world box; smaller curved surfaces get fewer segments
  (∝ √radius, in steps of 12, 16, 24, 32, 48, …, at least 12), so facets keep
  about the same size. Tessellation depends only on the surface, so faces
  shared by neighbouring cells still match, and the annulus generator stitches
  rings of different counts. Another 1.5× on the ICSBEP models (32% fewer
  triangles); turn it off with *Preferences → Adaptive*.
- **Robustness**: planes come from Newell's method; degenerate polygons and
  repeated vertices are dropped. A bounding-box check short-circuits booleans
  on disjoint operands. Mirroring transforms reverse winding so solids stay
  outward-facing.
- **FFI**: plain `extern "C"` exports with `u32` handles into a table inside
  wasm (0 means error). Bulk data crosses through linear memory. No
  wasm-bindgen or wasm-pack is needed, only `cargo`.

## Limitations

- Output is a polygon soup with T-junctions, as with any BSP CSG. Fine for
  rendering and most STL slicers; weld vertices first if you need a strict
  manifold.
- BSP booleans fragment polygons. Long chains of operations on dense meshes
  grow triangle counts quickly (the "Swiss cheese" example reaches ~126k
  triangles).
- Uses a fixed 1e-5 epsilon, so very small or very large models should be
  scaled toward unit size.
