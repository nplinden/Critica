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
      return boxes.reduce(conj ? intersectBoxes : unionBoxes);
    }
  }
  return infiniteBox();
}

export const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
