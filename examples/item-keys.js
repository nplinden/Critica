// Cache keys of top-level items: a hash of everything an item's geometry
// depends on, computable without building it. Two scenes give an item the
// same key exactly when its parts (meshes, tags, measures) are the same, so a
// mesh cache can serve it across sessions.
//
// An item depends on its subtree (names, colors and other display fields
// aside), the sources of its references and the universes it fills
// (recursively), the type and coefficients of the surfaces its half-spaces
// use, the resolved world box and the tessellation settings, and the version
// of the evaluator below.

/** Bump whenever evaluation or tessellation output changes, to retire old cache entries. */
export const CACHE_VERSION = 1;

const DISPLAY_ONLY = new Set(["name", "collapsed", "surfacesOpen", "color"]);
const canonical = (node) => JSON.stringify(node, (k, v) => (DISPLAY_ONLY.has(k) ? undefined : v));

/** cyrb53: a fast 53-bit string hash. */
function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Map<item id, key> for the given top-level item ids of `scene`. */
export function itemKeys(scene, ids, world = scene.resolveWorld()) {
  const settings = JSON.stringify([CACHE_VERSION, world, scene.world.segments ?? 48, scene.world.adaptive !== false]);
  const keys = new Map();
  for (const id of ids) {
    const root = scene.find(id)?.node;
    if (!root) continue;
    const extra = new Map(); // referenced sources and filled universes
    const surfaces = new Set();
    const visit = (top) => {
      scene.walk((n) => {
        if (n.kind === "halfspace") surfaces.add(n.params.surface);
        if (n.kind === "ref" && !extra.has(n.params.target)) {
          const target = scene.find(n.params.target)?.node;
          if (target) {
            extra.set(target.id, canonical(target));
            visit(target);
          }
        }
        if (n.fill?.type === "universe" && !extra.has(n.fill.universe)) {
          const u = scene.find(n.fill.universe)?.node;
          if (u) {
            extra.set(u.id, canonical(u));
            visit(u);
          }
        }
      }, [top]);
    };
    visit(root);
    const parts = [
      settings,
      canonical(root),
      ...[...extra].sort((a, b) => a[0] - b[0]).map(([, json]) => json),
      ...[...surfaces].sort((a, b) => a - b).map((sid) => {
        const s = scene.surfaces.get(sid);
        return s ? JSON.stringify([sid, s.type, s.coeffs]) : `missing ${sid}`;
      }),
    ].join("\n");
    keys.set(id, `${hash53(parts, 1)}-${hash53(parts, 2)}`);
  }
  return keys;
}
