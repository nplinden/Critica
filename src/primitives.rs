//! Primitive solid generators. All primitives are Y-up and produce
//! outward-facing polygons.

use crate::csg::{Polygon, Solid, Vertex};
use crate::math::Vec3;
use std::f64::consts::{PI, TAU};

/// Axis-aligned box centered at `center` with half-extents `radius`.
pub fn cuboid(center: Vec3, radius: Vec3) -> Solid {
    const FACES: [([usize; 4], [f64; 3]); 6] = [
        ([0, 4, 6, 2], [-1.0, 0.0, 0.0]),
        ([1, 3, 7, 5], [1.0, 0.0, 0.0]),
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
        ([2, 6, 7, 3], [0.0, 1.0, 0.0]),
        ([0, 2, 3, 1], [0.0, 0.0, -1.0]),
        ([4, 5, 7, 6], [0.0, 0.0, 1.0]),
    ];
    let corner = |i: usize| {
        let sign = |bit: usize| if i & bit != 0 { 1.0 } else { -1.0 };
        center + Vec3::new(radius.x * sign(1), radius.y * sign(2), radius.z * sign(4))
    };
    let polygons = FACES
        .iter()
        .filter_map(|(idx, n)| {
            let normal = Vec3::new(n[0], n[1], n[2]);
            Polygon::new(idx.iter().map(|&i| Vertex::new(corner(i), normal)).collect(), 0)
        })
        .collect();
    Solid::from_polygons(polygons)
}

/// UV sphere with `slices` around the Y axis and `stacks` from pole to pole.
pub fn sphere(center: Vec3, radius: f64, slices: u32, stacks: u32) -> Solid {
    let slices = slices.max(3);
    let stacks = stacks.max(2);
    let vertex = |theta: f64, phi: f64| {
        let (theta, phi) = (theta * TAU, phi * PI);
        let dir = Vec3::new(theta.cos() * phi.sin(), phi.cos(), theta.sin() * phi.sin());
        Vertex::new(center + dir * radius, dir)
    };
    let (s, t) = (slices as f64, stacks as f64);
    let mut polygons = Vec::with_capacity((slices * stacks) as usize);
    for i in 0..slices {
        for j in 0..stacks {
            let (i, j) = (i as f64, j as f64);
            let mut vertices = vec![vertex(i / s, j / t)];
            if j > 0.0 {
                vertices.push(vertex((i + 1.0) / s, j / t));
            }
            if j < t - 1.0 {
                vertices.push(vertex((i + 1.0) / s, (j + 1.0) / t));
            }
            vertices.push(vertex(i / s, (j + 1.0) / t));
            polygons.extend(Polygon::new(vertices, 0));
        }
    }
    Solid::from_polygons(polygons)
}

/// Cylinder or truncated cone from `start` to `end` with radii `r_start`
/// and `r_end`. Set either radius to 0 for a cone.
pub fn frustum(start: Vec3, end: Vec3, r_start: f64, r_end: f64, slices: u32) -> Solid {
    let slices = slices.max(3);
    let ray = end - start;
    let height = ray.length();
    if height <= 0.0 || (r_start <= 0.0 && r_end <= 0.0) {
        return Solid::default();
    }
    let axis_z = ray / height;
    let axis_x = axis_z.any_perpendicular();
    let axis_y = axis_x.cross(axis_z).normalize();

    let outward = |t: f64| {
        let angle = t * TAU;
        axis_x * angle.cos() + axis_y * angle.sin()
    };
    let side_normal = |out: Vec3| (out * height + axis_z * (r_start - r_end)).normalize();
    let ring = |stack: f64, t: f64, normal: Option<Vec3>| {
        let out = outward(t);
        let r = r_start + (r_end - r_start) * stack;
        Vertex::new(start + ray * stack + out * r, normal.unwrap_or_else(|| side_normal(out)))
    };

    let start_cap = Vertex::new(start, -axis_z);
    let end_cap = Vertex::new(end, axis_z);
    let mut polygons = Vec::with_capacity(slices as usize * 3);
    for i in 0..slices {
        let t0 = i as f64 / slices as f64;
        let t1 = (i + 1) as f64 / slices as f64;
        polygons.extend(Polygon::new(
            vec![start_cap, ring(0.0, t0, Some(-axis_z)), ring(0.0, t1, Some(-axis_z))],
            0,
        ));
        polygons.extend(Polygon::new(
            vec![ring(0.0, t1, None), ring(0.0, t0, None), ring(1.0, t0, None), ring(1.0, t1, None)],
            0,
        ));
        polygons.extend(Polygon::new(
            vec![end_cap, ring(1.0, t1, Some(axis_z)), ring(1.0, t0, Some(axis_z))],
            0,
        ));
    }
    Solid::from_polygons(polygons)
}

/// Annular tube between `start` and `end`: the space between radii `r_inner`
/// and `r_outer` (a plain cylinder when `r_inner` is 0). Its rings use the
/// same vertices as `frustum`, so it lines up with cylinders of the same axis
/// and slices. Faces carry `tags`: [outer side, inner side, start cap, end cap].
pub fn tube(start: Vec3, end: Vec3, r_inner: f64, r_outer: f64, slices: u32, tags: [u32; 4]) -> Solid {
    let slices = slices.max(3);
    let ray = end - start;
    let height = ray.length();
    if height <= 0.0 || r_outer <= 0.0 || r_inner >= r_outer {
        return Solid::default();
    }
    let axis_z = ray / height;
    let axis_x = axis_z.any_perpendicular();
    let axis_y = axis_x.cross(axis_z).normalize();
    let outward = |t: f64| {
        let angle = t * TAU;
        axis_x * angle.cos() + axis_y * angle.sin()
    };
    let [t_out, t_in, t_start, t_end] = tags;
    let at = |stack: f64, t: f64, r: f64, normal: Vec3| Vertex::new(start + ray * stack + outward(t) * r, normal);
    let hollow = r_inner > 0.0;
    let mut polygons = Vec::with_capacity(slices as usize * 4);
    for i in 0..slices {
        let t0 = i as f64 / slices as f64;
        let t1 = (i + 1) as f64 / slices as f64;
        let (o0, o1) = (outward(t0), outward(t1));
        polygons.extend(Polygon::new(
            vec![at(0.0, t1, r_outer, o1), at(0.0, t0, r_outer, o0), at(1.0, t0, r_outer, o0), at(1.0, t1, r_outer, o1)],
            t_out,
        ));
        let down = -axis_z;
        if hollow {
            polygons.extend(Polygon::new(
                vec![at(0.0, t0, r_inner, -o0), at(0.0, t1, r_inner, -o1), at(1.0, t1, r_inner, -o1), at(1.0, t0, r_inner, -o0)],
                t_in,
            ));
            polygons.extend(Polygon::new(
                vec![at(0.0, t0, r_inner, down), at(0.0, t0, r_outer, down), at(0.0, t1, r_outer, down), at(0.0, t1, r_inner, down)],
                t_start,
            ));
            polygons.extend(Polygon::new(
                vec![at(1.0, t1, r_inner, axis_z), at(1.0, t1, r_outer, axis_z), at(1.0, t0, r_outer, axis_z), at(1.0, t0, r_inner, axis_z)],
                t_end,
            ));
        } else {
            polygons.extend(Polygon::new(vec![Vertex::new(start, down), at(0.0, t0, r_outer, down), at(0.0, t1, r_outer, down)], t_start));
            polygons.extend(Polygon::new(vec![Vertex::new(end, axis_z), at(1.0, t1, r_outer, axis_z), at(1.0, t0, r_outer, axis_z)], t_end));
        }
    }
    Solid::from_polygons(polygons)
}

/// Torus around the Y axis. `major` is the distance from the center to the
/// tube center, `minor` the tube radius.
pub fn torus(center: Vec3, major: f64, minor: f64, segments: u32, rings: u32) -> Solid {
    let segments = segments.max(3);
    let rings = rings.max(3);
    let vertex = |i: u32, j: u32| {
        let u = i as f64 / segments as f64 * TAU;
        let v = j as f64 / rings as f64 * TAU;
        let normal = Vec3::new(v.cos() * u.cos(), v.sin(), v.cos() * u.sin());
        let tube = Vec3::new(major * u.cos(), 0.0, major * u.sin());
        Vertex::new(center + tube + normal * minor, normal)
    };
    let mut polygons = Vec::with_capacity((segments * rings) as usize);
    for i in 0..segments {
        for j in 0..rings {
            polygons.extend(Polygon::new(
                vec![vertex(i, j), vertex(i, j + 1), vertex(i + 1, j + 1), vertex(i + 1, j)],
                0,
            ));
        }
    }
    Solid::from_polygons(polygons)
}

/// Builds a solid from an indexed triangle mesh (counter-clockwise winding
/// when seen from outside). The mesh should be closed and manifold for
/// boolean operations to give meaningful results. Out-of-range indices and
/// degenerate triangles are skipped.
pub fn from_triangles(positions: &[f64], indices: &[u32]) -> Solid {
    let point = |i: u32| {
        let i = i as usize * 3;
        positions
            .get(i..i + 3)
            .map(|p| Vec3::new(p[0], p[1], p[2]))
    };
    let polygons = indices
        .chunks_exact(3)
        .filter_map(|tri| {
            let (a, b, c) = (point(tri[0])?, point(tri[1])?, point(tri[2])?);
            let n = (b - a).cross(c - a).normalize();
            Polygon::new(vec![Vertex::new(a, n), Vertex::new(b, n), Vertex::new(c, n)], 0)
        })
        .collect();
    Solid::from_polygons(polygons)
}
