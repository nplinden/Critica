//! Constructive solid geometry on polygon soups using BSP trees.
//!
//! The boolean algorithm follows Evan Wallace's csg.js: each operand is
//! compiled into a BSP tree, the trees clip each other's polygons, and the
//! surviving polygons are merged. The BSP tree is stored in an arena and every
//! traversal is iterative, so deep trees (e.g. high-resolution convex shapes,
//! which degenerate into a linked list) cannot overflow the wasm stack.

use crate::math::{Mat4, Vec3};

/// Tolerance used to classify points against planes.
pub const EPSILON: f64 = 1e-5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex {
    pub pos: Vec3,
    pub normal: Vec3,
}

impl Vertex {
    pub fn new(pos: Vec3, normal: Vec3) -> Self {
        Vertex { pos, normal }
    }

    fn flip(&mut self) {
        self.normal = -self.normal;
    }

    fn interpolate(&self, o: &Vertex, t: f64) -> Vertex {
        Vertex::new(
            self.pos.lerp(o.pos, t),
            self.normal.lerp(o.normal, t).normalize(),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub normal: Vec3,
    pub w: f64,
}

const COPLANAR: u8 = 0;
const FRONT: u8 = 1;
const BACK: u8 = 2;
const SPANNING: u8 = 3;

impl Plane {
    /// Plane through a polygon using Newell's method, which is robust for
    /// slightly non-planar input and polygons with repeated vertices.
    /// Returns `None` for degenerate (zero-area) polygons.
    pub fn from_vertices(vertices: &[Vertex]) -> Option<Plane> {
        let mut n = Vec3::ZERO;
        let mut centroid = Vec3::ZERO;
        for (i, a) in vertices.iter().enumerate() {
            let b = &vertices[(i + 1) % vertices.len()];
            n.x += (a.pos.y - b.pos.y) * (a.pos.z + b.pos.z);
            n.y += (a.pos.z - b.pos.z) * (a.pos.x + b.pos.x);
            n.z += (a.pos.x - b.pos.x) * (a.pos.y + b.pos.y);
            centroid = centroid + a.pos;
        }
        // |n| is twice the polygon area; reject slivers.
        if n.length() < 1e-12 {
            return None;
        }
        let normal = n.normalize();
        let centroid = centroid / vertices.len() as f64;
        Some(Plane {
            normal,
            w: normal.dot(centroid),
        })
    }

    fn flip(&mut self) {
        self.normal = -self.normal;
        self.w = -self.w;
    }

    /// Splits `polygon` by this plane, pushing the pieces into the matching
    /// buckets. Coplanar polygons go to `coplanar_front` or `coplanar_back`
    /// depending on their orientation relative to this plane.
    fn split_polygon(
        &self,
        polygon: Polygon,
        coplanar_front: &mut Vec<Polygon>,
        coplanar_back: &mut Vec<Polygon>,
        front: &mut Vec<Polygon>,
        back: &mut Vec<Polygon>,
    ) {
        let mut polygon_type = 0u8;
        let types: Vec<u8> = polygon
            .vertices
            .iter()
            .map(|v| {
                let t = self.normal.dot(v.pos) - self.w;
                let ty = if t < -EPSILON {
                    BACK
                } else if t > EPSILON {
                    FRONT
                } else {
                    COPLANAR
                };
                polygon_type |= ty;
                ty
            })
            .collect();

        match polygon_type {
            COPLANAR => {
                if self.normal.dot(polygon.plane.normal) > 0.0 {
                    coplanar_front.push(polygon);
                } else {
                    coplanar_back.push(polygon);
                }
            }
            FRONT => front.push(polygon),
            BACK => back.push(polygon),
            _ => {
                let n = polygon.vertices.len();
                let mut f = Vec::with_capacity(n + 1);
                let mut b = Vec::with_capacity(n + 1);
                for i in 0..n {
                    let j = (i + 1) % n;
                    let (ti, tj) = (types[i], types[j]);
                    let (vi, vj) = (&polygon.vertices[i], &polygon.vertices[j]);
                    if ti != BACK {
                        f.push(*vi);
                    }
                    if ti != FRONT {
                        b.push(*vi);
                    }
                    if (ti | tj) == SPANNING {
                        let t = (self.w - self.normal.dot(vi.pos))
                            / self.normal.dot(vj.pos - vi.pos);
                        let v = vi.interpolate(vj, t);
                        f.push(v);
                        b.push(v);
                    }
                }
                if f.len() >= 3 {
                    front.push(Polygon::with_plane(f, polygon.plane, polygon.shared));
                }
                if b.len() >= 3 {
                    back.push(Polygon::with_plane(b, polygon.plane, polygon.shared));
                }
            }
        }
    }
}

/// A convex, planar polygon. `shared` is an opaque tag (e.g. a material or
/// color id) that is carried through boolean operations unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct Polygon {
    pub vertices: Vec<Vertex>,
    pub plane: Plane,
    pub shared: u32,
}

impl Polygon {
    /// Builds a polygon, returning `None` if it is degenerate. Consecutive
    /// duplicate vertices (e.g. at a cone's apex) are dropped.
    pub fn new(mut vertices: Vec<Vertex>, shared: u32) -> Option<Polygon> {
        let same = |a: &Vertex, b: &Vertex| (a.pos - b.pos).length() < EPSILON;
        vertices.dedup_by(|a, b| same(a, b));
        while vertices.len() > 1 && same(&vertices[0], &vertices[vertices.len() - 1]) {
            vertices.pop();
        }
        if vertices.len() < 3 {
            return None;
        }
        let plane = Plane::from_vertices(&vertices)?;
        Some(Polygon {
            vertices,
            plane,
            shared,
        })
    }

    fn with_plane(vertices: Vec<Vertex>, plane: Plane, shared: u32) -> Polygon {
        Polygon {
            vertices,
            plane,
            shared,
        }
    }

    pub fn flip(&mut self) {
        self.vertices.reverse();
        for v in &mut self.vertices {
            v.flip();
        }
        self.plane.flip();
    }
}

/// A BSP tree node. Children are indices into the owning tree's arena.
#[derive(Clone, Debug, Default)]
struct Node {
    plane: Option<Plane>,
    front: Option<usize>,
    back: Option<usize>,
    polygons: Vec<Polygon>,
}

#[derive(Clone, Debug)]
struct Bsp {
    nodes: Vec<Node>,
}

impl Bsp {
    fn new(polygons: Vec<Polygon>) -> Bsp {
        let mut bsp = Bsp {
            nodes: vec![Node::default()],
        };
        bsp.build(polygons);
        bsp
    }

    /// Converts solid space to empty space and vice versa.
    fn invert(&mut self) {
        for node in &mut self.nodes {
            for p in &mut node.polygons {
                p.flip();
            }
            if let Some(plane) = &mut node.plane {
                plane.flip();
            }
            std::mem::swap(&mut node.front, &mut node.back);
        }
    }

    /// Removes the parts of `polygons` that lie inside this tree's solid.
    fn clip_polygons(&self, polygons: Vec<Polygon>) -> Vec<Polygon> {
        let mut out = Vec::new();
        let mut stack = vec![(0usize, polygons)];
        while let Some((idx, polys)) = stack.pop() {
            let node = &self.nodes[idx];
            let Some(plane) = node.plane else {
                out.extend(polys);
                continue;
            };
            let mut front = Vec::new();
            let mut back = Vec::new();
            for p in polys {
                let (cf, cb) = (&mut Vec::new(), &mut Vec::new());
                plane.split_polygon(p, cf, cb, &mut front, &mut back);
                front.append(cf);
                back.append(cb);
            }
            match node.front {
                Some(f) => stack.push((f, front)),
                None => out.extend(front),
            }
            // Polygons that reach a missing back child are inside: discard.
            if let Some(b) = node.back {
                stack.push((b, back));
            }
        }
        out
    }

    /// Removes all polygons in this tree that are inside `other`.
    fn clip_to(&mut self, other: &Bsp) {
        for node in &mut self.nodes {
            if !node.polygons.is_empty() {
                let polys = std::mem::take(&mut node.polygons);
                node.polygons = other.clip_polygons(polys);
            }
        }
    }

    fn into_polygons(self) -> Vec<Polygon> {
        self.nodes.into_iter().flat_map(|n| n.polygons).collect()
    }

    /// Inserts polygons into the tree, creating nodes as needed. The first
    /// polygon reaching an empty node supplies its splitting plane.
    fn build(&mut self, polygons: Vec<Polygon>) {
        let mut stack = vec![(0usize, polygons)];
        while let Some((idx, polys)) = stack.pop() {
            if polys.is_empty() {
                continue;
            }
            let plane = *self.nodes[idx].plane.get_or_insert(polys[0].plane);
            let mut coplanar = Vec::new();
            let mut front = Vec::new();
            let mut back = Vec::new();
            for p in polys {
                let mut cb = Vec::new();
                plane.split_polygon(p, &mut coplanar, &mut cb, &mut front, &mut back);
                coplanar.append(&mut cb);
            }
            self.nodes[idx].polygons.append(&mut coplanar);
            if !front.is_empty() {
                let child = self.child(idx, true);
                stack.push((child, front));
            }
            if !back.is_empty() {
                let child = self.child(idx, false);
                stack.push((child, back));
            }
        }
    }

    fn child(&mut self, idx: usize, front: bool) -> usize {
        let existing = if front {
            self.nodes[idx].front
        } else {
            self.nodes[idx].back
        };
        if let Some(c) = existing {
            return c;
        }
        let c = self.nodes.len();
        self.nodes.push(Node::default());
        if front {
            self.nodes[idx].front = Some(c);
        } else {
            self.nodes[idx].back = Some(c);
        }
        c
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min: Vec3,
    pub max: Vec3,
}

impl Bounds {
    fn overlaps(&self, o: &Bounds) -> bool {
        self.min.x <= o.max.x + EPSILON
            && self.max.x + EPSILON >= o.min.x
            && self.min.y <= o.max.y + EPSILON
            && self.max.y + EPSILON >= o.min.y
            && self.min.z <= o.max.z + EPSILON
            && self.max.z + EPSILON >= o.min.z
    }
}

/// A closed solid represented as a soup of convex polygons with outward
/// facing planes. All operations are non-destructive.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Solid {
    pub polygons: Vec<Polygon>,
}

impl Solid {
    pub fn from_polygons(polygons: Vec<Polygon>) -> Solid {
        Solid { polygons }
    }

    pub fn is_empty(&self) -> bool {
        self.polygons.is_empty()
    }

    /// `self ∪ other`
    pub fn union(&self, other: &Solid) -> Solid {
        if self.is_empty() {
            return other.clone();
        }
        if other.is_empty() {
            return self.clone();
        }
        if !self.overlaps(other) {
            let mut polygons = self.polygons.clone();
            polygons.extend(other.polygons.iter().cloned());
            return Solid { polygons };
        }
        let mut a = Bsp::new(self.polygons.clone());
        let mut b = Bsp::new(other.polygons.clone());
        a.clip_to(&b);
        b.clip_to(&a);
        b.invert();
        b.clip_to(&a);
        b.invert();
        a.build(b.into_polygons());
        Solid {
            polygons: a.into_polygons(),
        }
    }

    /// `self − other`
    pub fn subtract(&self, other: &Solid) -> Solid {
        if self.is_empty() || other.is_empty() || !self.overlaps(other) {
            return self.clone();
        }
        let mut a = Bsp::new(self.polygons.clone());
        let mut b = Bsp::new(other.polygons.clone());
        a.invert();
        a.clip_to(&b);
        b.clip_to(&a);
        b.invert();
        b.clip_to(&a);
        b.invert();
        a.build(b.into_polygons());
        a.invert();
        Solid {
            polygons: a.into_polygons(),
        }
    }

    /// `self ∩ other`
    pub fn intersect(&self, other: &Solid) -> Solid {
        if self.is_empty() || other.is_empty() || !self.overlaps(other) {
            return Solid::default();
        }
        let mut a = Bsp::new(self.polygons.clone());
        let mut b = Bsp::new(other.polygons.clone());
        a.invert();
        b.clip_to(&a);
        b.invert();
        a.clip_to(&b);
        b.clip_to(&a);
        a.build(b.into_polygons());
        a.invert();
        Solid {
            polygons: a.into_polygons(),
        }
    }

    /// Turns the solid inside out.
    pub fn inverse(&self) -> Solid {
        let mut s = self.clone();
        for p in &mut s.polygons {
            p.flip();
        }
        s
    }

    /// Applies an affine transform. Mirroring transforms (negative
    /// determinant) reverse winding so faces keep pointing outward.
    pub fn transform(&self, m: &Mat4) -> Solid {
        let mirror = m.det3() < 0.0;
        let polygons = self
            .polygons
            .iter()
            .filter_map(|p| {
                let mut vertices: Vec<Vertex> = p
                    .vertices
                    .iter()
                    .map(|v| Vertex::new(m.transform_point(v.pos), m.transform_normal(v.normal)))
                    .collect();
                if mirror {
                    vertices.reverse();
                }
                Polygon::new(vertices, p.shared)
            })
            .collect();
        Solid { polygons }
    }

    pub fn translate(&self, t: Vec3) -> Solid {
        self.transform(&Mat4::translation(t))
    }

    pub fn rotate(&self, axis: Vec3, degrees: f64) -> Solid {
        self.transform(&Mat4::rotation(axis, degrees))
    }

    pub fn scale(&self, s: Vec3) -> Solid {
        self.transform(&Mat4::scaling(s))
    }

    /// Sets the `shared` tag on every polygon.
    pub fn with_tag(&self, tag: u32) -> Solid {
        let mut s = self.clone();
        for p in &mut s.polygons {
            p.shared = tag;
        }
        s
    }

    pub fn bounds(&self) -> Option<Bounds> {
        let mut it = self.polygons.iter().flat_map(|p| p.vertices.iter());
        let first = it.next()?.pos;
        let (min, max) = it.fold((first, first), |(lo, hi), v| (lo.min(v.pos), hi.max(v.pos)));
        Some(Bounds { min, max })
    }

    fn overlaps(&self, other: &Solid) -> bool {
        match (self.bounds(), other.bounds()) {
            (Some(a), Some(b)) => a.overlaps(&b),
            _ => false,
        }
    }

    /// Signed volume via the divergence theorem (positive for outward faces).
    pub fn volume(&self) -> f64 {
        let mut v = 0.0;
        for p in &self.polygons {
            let a = p.vertices[0].pos;
            for w in p.vertices[1..].windows(2) {
                v += a.dot(w[0].pos.cross(w[1].pos));
            }
        }
        v / 6.0
    }

    /// Total surface area.
    pub fn surface_area(&self) -> f64 {
        let mut area = 0.0;
        for p in &self.polygons {
            let a = p.vertices[0].pos;
            for w in p.vertices[1..].windows(2) {
                area += (w[0].pos - a).cross(w[1].pos - a).length();
            }
        }
        area / 2.0
    }

    pub fn triangle_count(&self) -> usize {
        self.polygons.iter().map(|p| p.vertices.len() - 2).sum()
    }
}
