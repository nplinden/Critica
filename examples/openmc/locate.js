// Analytic point location in a scene, following OpenMC semantics exactly
// (no meshes involved). Used to validate the mesh evaluator and the exporter,
// and usable as a probe in the UI.

import { evaluate } from "./surfaces.js";
import { contains } from "./region.js";
import { isCell, isIdentity, isPrimitive, compositeExpansion } from "../scene.js";
import * as M4 from "../mat4.js";

/** World → local position for a cell fill, literally as src/geometry.cpp does it. */
export function fillLocalPosition(t, p) {
  if ((t.order ?? "zyx") !== "zyx" || t.scale.some((v) => v !== 1)) {
    return M4.transformPoint(M4.invert(M4.fromTransform(t)), p);
  }
  const q = p.map((v, i) => v - t.position[i]);
  if (t.rotation.every((v) => v === 0)) return q;
  // src/cell.cpp: matrix of the documented formula evaluated at -angles.
  const [phi, theta, psi] = t.rotation.map((d) => (-d * Math.PI) / 180);
  const { cos, sin } = Math;
  const R = [
    cos(theta) * cos(psi),
    -cos(phi) * sin(psi) + sin(phi) * sin(theta) * cos(psi),
    sin(phi) * sin(psi) + cos(phi) * sin(theta) * cos(psi),
    cos(theta) * sin(psi),
    cos(phi) * cos(psi) + sin(phi) * sin(theta) * sin(psi),
    -sin(phi) * cos(psi) + cos(phi) * sin(theta) * sin(psi),
    -sin(theta),
    sin(phi) * cos(theta),
    cos(phi) * cos(theta),
  ];
  // Position::rotate (row-major).
  return [0, 1, 2].map((r) => R[r * 3] * q[0] + R[r * 3 + 1] * q[1] + R[r * 3 + 2] * q[2]);
}

function insidePrimitive(node, q) {
  const p = node.params;
  const [x, y, z] = q;
  switch (node.kind) {
    case "cube":
      return Math.abs(x) < p.size[0] / 2 && Math.abs(y) < p.size[1] / 2 && Math.abs(z) < p.size[2] / 2;
    case "sphere":
      return x * x + y * y + z * z < p.radius ** 2;
    case "cylinder": {
      const k = { x: 0, y: 1, z: 2 }[p.axis ?? "y"];
      const [u, v] = q.filter((_, i) => i !== k);
      return u * u + v * v < p.radius ** 2 && Math.abs(q[k]) < p.height / 2;
    }
    case "cone":
      return Math.abs(y) < p.height / 2 && Math.hypot(x, z) < (p.radius * (p.height / 2 - y)) / p.height;
    case "torus":
      return (Math.hypot(x, z) - p.major) ** 2 + y * y < p.minor ** 2;
  }
  return false;
}

/** Whether point `p` (in the node's parent frame) is inside a region node. */
export function insideNode(scene, node, p, depth = 0) {
  const q = isIdentity(node.transform) ? p : M4.transformPoint(M4.invert(M4.fromTransform(node.transform)), p);
  if (node.kind === "halfspace") {
    const f = evaluate(scene.surfaces.get(node.params.surface), q);
    return node.params.sense === "-" ? f < 0 : f >= 0;
  }
  if (node.kind === "ref") {
    const target = scene.find(node.params.target)?.node;
    if (!target || depth > 64) return false;
    return insideNode(scene, target, q, depth + 1);
  }
  if (node.kind === "composite") {
    const { surfaces, region } = compositeExpansion(node);
    const inside = contains(region, new Map(surfaces.map((s, i) => [i, s])), q);
    return node.params.sense === "-" ? inside : !inside;
  }
  if (isPrimitive(node)) return insidePrimitive(node, q);
  const kids = node.children.filter((c) => c.enabled);
  switch (node.kind) {
    case "union":
      return kids.some((c) => insideNode(scene, c, q, depth));
    case "intersect":
      return kids.length > 0 && kids.every((c) => insideNode(scene, c, q, depth));
    case "subtract":
      return kids.length > 0 && insideNode(scene, kids[0], q, depth) && !kids.slice(1).some((c) => insideNode(scene, c, q, depth));
    case "complement":
      return kids.length > 0 && !insideNode(scene, kids[0], q, depth);
  }
  return false;
}

/**
 * The innermost item containing `p`: a material cell, a placeholder-filled cell,
 * or a top-level shape. Items are tried in order (earlier items win overlaps).
 * Returns { node, path } or null.
 */
export function locate(scene, p, items = scene.roots, path = []) {
  for (const item of items) {
    if (!item.enabled) continue;
    if (isCell(item)) {
      const region = item.children.find((c) => c.enabled);
      if (region && !insideNode(scene, region, p)) continue;
      if (item.fill.type === "universe") {
        const u = scene.find(item.fill.universe)?.node;
        if (!u) return null;
        return locate(scene, fillLocalPosition(item.transform, p), u.children, [...path, item]);
      }
      return { node: item, path: [...path, item] };
    }
    if (insideNode(scene, item, p)) return { node: item, path: [...path, item] };
  }
  return null;
}
