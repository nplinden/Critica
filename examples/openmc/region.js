// OpenMC region expressions: "-1 2 | ~(3 -4)".
// Precedence (as in src/cell.cpp): parentheses, complement, intersection, union.
// Intersection is implicit between adjacent operands.
//
// AST: { op: "half", surface: id, sense: "-" | "+" }
//    | { op: "and" | "or", args: AST[] }
//    | { op: "not", arg: AST }

import { evaluate, halfspaceBounds, infiniteBox } from "./surfaces.js";

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if ("()|~".includes(ch)) {
      tokens.push(ch);
      i++;
    } else if (ch === "-" || ch === "+" || /\d/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/\d/.test(text)) throw new Error(`region "${src}": "${text}" is not a half-space`);
      tokens.push({ surface: Math.abs(parseInt(text, 10)), sense: ch === "-" ? "-" : "+" });
      i = j;
    } else {
      throw new Error(`region "${src}": invalid character "${ch}"`);
    }
  }
  return tokens;
}

export function parseRegion(src) {
  const tokens = tokenize(src);
  if (tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const startsOperand = (t) => t !== undefined && (typeof t === "object" || t === "(" || t === "~");

  // Nested groups of the same operator are flattened: (1 2) 3 → and(1, 2, 3).
  const push = (args, node, op) => (node.op === op ? args.push(...node.args) : args.push(node));
  const parseUnion = () => {
    const args = [];
    push(args, parseIntersection(), "or");
    while (peek() === "|") {
      pos++;
      push(args, parseIntersection(), "or");
    }
    return args.length === 1 ? args[0] : { op: "or", args };
  };
  const parseIntersection = () => {
    const args = [];
    push(args, parseUnary(), "and");
    while (startsOperand(peek())) push(args, parseUnary(), "and");
    return args.length === 1 ? args[0] : { op: "and", args };
  };
  const parseUnary = () => {
    const t = peek();
    if (t === "~") {
      pos++;
      return { op: "not", arg: parseUnary() };
    }
    if (t === "(") {
      pos++;
      const inner = parseUnion();
      if (peek() !== ")") throw new Error(`region "${src}": missing ")"`);
      pos++;
      return inner;
    }
    if (typeof t === "object") {
      pos++;
      return { op: "half", surface: t.surface, sense: t.sense };
    }
    throw new Error(`region "${src}": unexpected ${t === undefined ? "end" : `"${t}"`}`);
  };

  const ast = parseUnion();
  if (pos !== tokens.length) throw new Error(`region "${src}": unexpected "${tokens[pos]}"`);
  return ast;
}

const PREC = { or: 1, and: 2, not: 3, half: 4 };

/** Formats an AST with the minimum number of parentheses. */
export function formatRegion(ast, parentPrec = 0) {
  if (!ast) return "";
  let s;
  switch (ast.op) {
    case "half":
      return `${ast.sense === "-" ? "-" : ""}${ast.surface}`;
    case "not": {
      const inner = formatRegion(ast.arg, PREC.not);
      return ast.arg.op === "half" || ast.arg.op === "not" ? `~${inner}` : `~(${formatRegion(ast.arg)})`;
    }
    case "and":
      s = ast.args.map((a) => formatRegion(a, PREC.and)).join(" ");
      break;
    case "or":
      s = ast.args.map((a) => formatRegion(a, PREC.or)).join(" | ");
      break;
  }
  return PREC[ast.op] < parentPrec ? `(${s})` : s;
}

export function surfaceIds(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.op === "half") out.add(ast.surface);
  else if (ast.op === "not") surfaceIds(ast.arg, out);
  else ast.args.forEach((a) => surfaceIds(a, out));
  return out;
}

/**
 * Point membership with OpenMC's convention (openmc.Halfspace.__contains__):
 * the negative side is f < 0, the positive side f ≥ 0.
 */
export function contains(ast, surfaces, p) {
  if (!ast) return true;
  switch (ast.op) {
    case "half": {
      const f = evaluate(surfaces.get(ast.surface), p);
      return ast.sense === "-" ? f < 0 : f >= 0;
    }
    case "not":
      return !contains(ast.arg, surfaces, p);
    case "and":
      return ast.args.every((a) => contains(a, surfaces, p));
    case "or":
      return ast.args.some((a) => contains(a, surfaces, p));
  }
  return false;
}

export const intersectBoxes = (a, b) => ({
  min: a.min.map((v, i) => Math.max(v, b.min[i])),
  max: a.max.map((v, i) => Math.min(v, b.max[i])),
});

export const unionBoxes = (a, b) => ({
  min: a.min.map((v, i) => Math.min(v, b.min[i])),
  max: a.max.map((v, i) => Math.max(v, b.max[i])),
});

/** Conservative axis-aligned bounds of a region (complements pushed down via De Morgan). */
export function regionBounds(ast, surfaces, negated = false) {
  if (!ast) return negated ? emptyBox() : infiniteBox();
  switch (ast.op) {
    case "half": {
      const sense = negated ? (ast.sense === "-" ? "+" : "-") : ast.sense;
      return halfspaceBounds(surfaces.get(ast.surface), sense);
    }
    case "not":
      return regionBounds(ast.arg, surfaces, !negated);
    case "and":
    case "or": {
      const conj = (ast.op === "and") !== negated;
      const boxes = ast.args.map((a) => regionBounds(a, surfaces, negated));
      const box = boxes.reduce(conj ? intersectBoxes : unionBoxes);
      if (!conj) return box;
      const planes = ast.args
        .filter((a) => a.op === "half")
        .map((a) => linearConstraint(surfaces.get(a.surface), negated ? (a.sense === "-" ? "+" : "-") : a.sense))
        .filter(Boolean);
      return refineByPlanes(box, planes);
    }
  }
  return infiniteBox();
}

/** A plane half-space as { n, d } meaning n·p ≤ d, or null for other surfaces. */
export function linearConstraint(s, sense) {
  if (!s) return null;
  const c = s.coeffs;
  let n;
  let d;
  if (s.type === "plane") {
    n = [c[0], c[1], c[2]];
    d = c[3];
  } else if (s.type === "x-plane" || s.type === "y-plane" || s.type === "z-plane") {
    n = [0, 0, 0];
    n["xyz".indexOf(s.type[0])] = 1;
    d = c[0];
  } else return null;
  // f = n·p − d; the negative side is n·p < d.
  return sense === "-" ? { n, d } : { n: n.map((v) => -v), d: -d };
}

/**
 * Tightens `box` (the bounds of an intersection) with the exact bounds of the
 * polyhedron cut by `planes` ({ n, d }: n·p ≤ d) inside it. Per-surface bounds
 * know nothing of oblique planes, so a hexagonal prism (two axis planes, four
 * oblique ones) would otherwise look unbounded across its flats. Corners are
 * where three planes meet inside all the others; an axis stays infinite when
 * the polyhedron reaches the far stand-in walls.
 */
export function refineByPlanes(box, planes) {
  if (planes.length < 2 || box.min.some((v, k) => v > box.max[k])) return box;
  const finite = [...box.min, ...box.max].filter(Number.isFinite);
  const scale = Math.max(1, ...finite.map(Math.abs), ...planes.map((p) => Math.abs(p.d) / (Math.hypot(...p.n) || 1)));
  const L = 1e6 * scale; // stand-in for infinity
  const all = planes.map((p) => {
    const len = Math.hypot(...p.n);
    return { n: p.n.map((v) => v / len), d: p.d / len };
  });
  for (let k = 0; k < 3; k++) {
    const e = [0, 0, 0];
    e[k] = 1;
    all.push({ n: e, d: Number.isFinite(box.max[k]) ? box.max[k] : L });
    all.push({ n: e.map((v) => -v), d: Number.isFinite(box.min[k]) ? -box.min[k] : L });
  }
  if (all.some((p) => !p.n.every(Number.isFinite) || !Number.isFinite(p.d))) return box;
  const tol = 1e-9 * L;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  let found = false;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      for (let k = j + 1; k < all.length; k++) {
        const [A, B, C] = [all[i], all[j], all[k]];
        const det = det3(A.n, B.n, C.n);
        if (Math.abs(det) < 1e-12) continue;
        // Cramer's rule on the rows n·p = d.
        const rows = [A, B, C];
        const p = [0, 1, 2].map((q) => det3(...rows.map((R) => R.n.map((v, r) => (r === q ? R.d : v)))) / det);
        if (!all.every((P) => P.n[0] * p[0] + P.n[1] * p[1] + P.n[2] * p[2] <= P.d + tol)) continue;
        found = true;
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], p[a]);
          hi[a] = Math.max(hi[a], p[a]);
        }
      }
  if (!found) return box;
  const out = { min: [...box.min], max: [...box.max] };
  for (let a = 0; a < 3; a++) {
    if (lo[a] > -L / 2) out.min[a] = Math.max(out.min[a], lo[a]);
    if (hi[a] < L / 2) out.max[a] = Math.min(out.max[a], hi[a]);
  }
  return out;
}

export const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
