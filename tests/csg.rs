use geomium::primitives::{cuboid, frustum, from_triangles, sphere, torus};
use geomium::{ffi, to_stl, Mat4, Mesh, Solid, Vec3};
use std::f64::consts::PI;

fn unit_cube() -> Solid {
    cuboid(Vec3::ZERO, Vec3::new(1.0, 1.0, 1.0))
}

fn assert_close(actual: f64, expected: f64, rel: f64) {
    let err = ((actual - expected) / expected).abs();
    assert!(
        err <= rel,
        "expected {expected}, got {actual} (relative error {err:.2e} > {rel:.0e})"
    );
}

/// Every edge of a closed manifold mesh must be shared by exactly two
/// faces with opposite directions. CSG output has T-junctions, so this
/// checks the weaker but still useful property that the oriented boundary
/// cancels out: the sum of edge vectors weighted by plane normals vanishes
/// (equivalently, signed area vectors sum to zero for a closed surface).
fn assert_closed(s: &Solid) {
    let mut sum = Vec3::ZERO;
    for p in &s.polygons {
        let a = p.vertices[0].pos;
        for w in p.vertices[1..].windows(2) {
            sum = sum + (w[0].pos - a).cross(w[1].pos - a);
        }
    }
    let scale = s.surface_area().max(1.0);
    assert!(sum.length() / scale < 1e-9, "surface is not closed: {sum:?}");
}

#[test]
fn primitive_volumes() {
    assert_close(unit_cube().volume(), 8.0, 1e-12);
    assert_close(sphere(Vec3::ZERO, 1.0, 128, 64).volume(), 4.0 / 3.0 * PI, 2e-3);
    assert_close(
        frustum(Vec3::ZERO, Vec3::new(0.0, 2.0, 0.0), 1.0, 1.0, 256).volume(),
        2.0 * PI,
        1e-3,
    );
    assert_close(
        frustum(Vec3::ZERO, Vec3::new(0.0, 0.0, 3.0), 1.0, 0.0, 256).volume(),
        PI,
        1e-3,
    );
    assert_close(
        torus(Vec3::ZERO, 2.0, 0.5, 128, 64).volume(),
        2.0 * PI * PI * 2.0 * 0.25,
        5e-3,
    );
    for s in [
        unit_cube(),
        sphere(Vec3::ZERO, 1.0, 16, 8),
        frustum(Vec3::ZERO, Vec3::new(1.0, 2.0, 3.0), 0.5, 0.0, 12),
        torus(Vec3::ZERO, 2.0, 0.5, 16, 8),
    ] {
        assert_closed(&s);
    }
}

#[test]
fn normals_point_outward() {
    for s in [
        unit_cube(),
        sphere(Vec3::ZERO, 1.0, 16, 8),
        frustum(Vec3::new(0.0, -1.0, 0.0), Vec3::new(0.0, 1.0, 0.0), 1.0, 0.5, 16),
        torus(Vec3::ZERO, 2.0, 0.5, 16, 8),
    ] {
        for p in &s.polygons {
            for v in &p.vertices {
                assert!(
                    v.normal.dot(p.plane.normal) > 0.0,
                    "vertex normal disagrees with face orientation"
                );
            }
        }
    }
}

#[test]
fn boolean_volumes_on_boxes() {
    let a = unit_cube();
    let b = unit_cube().translate(Vec3::new(1.0, 1.0, 1.0));
    let cases = [
        ("union", a.union(&b), 15.0),
        ("subtract", a.subtract(&b), 7.0),
        ("intersect", a.intersect(&b), 1.0),
        ("reverse subtract", b.subtract(&a), 7.0),
    ];
    for (name, s, expected) in cases {
        let v = s.volume();
        assert!((v - expected).abs() < 1e-9, "{name}: expected {expected}, got {v}");
        assert_closed(&s);
    }
}

#[test]
fn nested_and_disjoint() {
    let big = cuboid(Vec3::ZERO, Vec3::new(2.0, 2.0, 2.0));
    let small = unit_cube();
    assert_close(big.subtract(&small).volume(), 56.0, 1e-12);
    assert_close(big.union(&small).volume(), 64.0, 1e-12);
    assert_close(big.intersect(&small).volume(), 8.0, 1e-12);

    let far = small.translate(Vec3::new(10.0, 0.0, 0.0));
    assert_close(small.union(&far).volume(), 16.0, 1e-12);
    assert_close(small.subtract(&far).volume(), 8.0, 1e-12);
    assert!(small.intersect(&far).is_empty());
}

#[test]
fn coplanar_faces_merge() {
    // Two boxes sharing a full face: union must be a 4x2x2 box.
    let a = unit_cube();
    let b = unit_cube().translate(Vec3::new(2.0, 0.0, 0.0));
    let u = a.union(&b);
    assert_close(u.volume(), 16.0, 1e-12);
    assert_close(u.surface_area(), 2.0 * (8.0 + 8.0 + 4.0), 1e-12);
    // Subtracting an identical box leaves nothing.
    assert!(a.subtract(&a.clone()).volume().abs() < 1e-9);
}

#[test]
fn curved_booleans_partition_volume() {
    let s = sphere(Vec3::ZERO, 1.0, 48, 24);
    let c = frustum(Vec3::new(0.0, -2.0, 0.0), Vec3::new(0.0, 2.0, 0.0), 0.4, 0.4, 32)
        .rotate(Vec3::new(1.0, 0.0, 1.0), 33.0);
    let diff = s.subtract(&c);
    let inter = s.intersect(&c);
    // vol(A) = vol(A − B) + vol(A ∩ B) and vol(A ∪ B) = vol(A) + vol(B) − vol(A ∩ B)
    assert_close(diff.volume() + inter.volume(), s.volume(), 1e-9);
    assert_close(
        s.union(&c).volume(),
        s.volume() + c.volume() - inter.volume(),
        1e-9,
    );
    assert_closed(&diff);
    assert_closed(&inter);
}

#[test]
fn chained_operations() {
    // Classic CSG demo: (cube ∩ sphere) − (three cylinders).
    let body = cuboid(Vec3::ZERO, Vec3::new(1.0, 1.0, 1.0))
        .intersect(&sphere(Vec3::ZERO, 1.35, 32, 16));
    let axis = |d: Vec3| frustum(-d * 2.0, d * 2.0, 0.6, 0.6, 24);
    let holes = axis(Vec3::new(1.0, 0.0, 0.0))
        .union(&axis(Vec3::new(0.0, 1.0, 0.0)))
        .union(&axis(Vec3::new(0.0, 0.0, 1.0)));
    let part = body.subtract(&holes);
    assert!(part.volume() > 0.0 && part.volume() < body.volume());
    assert_close(part.volume() + body.intersect(&holes).volume(), body.volume(), 1e-9);
    assert_closed(&part);
}

#[test]
fn transforms() {
    let slab = cuboid(Vec3::ZERO, Vec3::new(2.0, 1.0, 0.5));
    let r = slab.rotate(Vec3::new(0.0, 0.0, 1.0), 90.0).bounds().unwrap();
    assert!((r.max.x - 1.0).abs() < 1e-12 && (r.max.y - 2.0).abs() < 1e-12);

    // Mirroring must keep the solid outward-facing (positive volume).
    let mirrored = sphere(Vec3::new(1.0, 0.0, 0.0), 1.0, 16, 8).scale(Vec3::new(-1.0, 1.0, 1.0));
    assert!(mirrored.volume() > 0.0);
    for p in &mirrored.polygons {
        for v in &p.vertices {
            assert!(v.normal.dot(p.plane.normal) > 0.0);
        }
    }

    // Non-uniform scale multiplies volume by the determinant.
    assert_close(unit_cube().scale(Vec3::new(2.0, 3.0, 0.5)).volume(), 24.0, 1e-12);

    // Composite matrix equals sequential transforms.
    let m = Mat4::translation(Vec3::new(1.0, 2.0, 3.0))
        .mul(&Mat4::rotation(Vec3::new(0.0, 1.0, 0.0), 45.0));
    let a = slab.transform(&m).bounds().unwrap();
    let b = slab
        .rotate(Vec3::new(0.0, 1.0, 0.0), 45.0)
        .translate(Vec3::new(1.0, 2.0, 3.0))
        .bounds()
        .unwrap();
    assert!((a.min - b.min).length() < 1e-12 && (a.max - b.max).length() < 1e-12);
}

#[test]
fn imported_triangles() {
    // Unit right tetrahedron, outward winding.
    let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
    let tet = from_triangles(&positions, &indices);
    assert_eq!(tet.polygons.len(), 4);
    assert_close(tet.volume(), 1.0 / 6.0, 1e-12);
    assert_close(unit_cube().intersect(&tet).volume(), 1.0 / 6.0, 1e-12);
    // Bad indices are skipped rather than panicking.
    assert!(from_triangles(&positions, &[0, 1, 99]).is_empty());
}

#[test]
fn mesh_and_stl_export() {
    let s = unit_cube().subtract(&sphere(Vec3::new(1.0, 1.0, 1.0), 1.0, 16, 8));
    let mesh = Mesh::from_solid(&s);
    assert_eq!(mesh.triangle_count(), s.triangle_count());
    assert_eq!(mesh.normals.len(), mesh.positions.len());
    assert_eq!(mesh.tags.len(), mesh.vertex_count());
    assert!(mesh.indices.iter().all(|&i| (i as usize) < mesh.vertex_count()));

    let stl = to_stl(&s);
    assert_eq!(stl.len(), 84 + 50 * s.triangle_count());
    let count = u32::from_le_bytes(stl[80..84].try_into().unwrap());
    assert_eq!(count as usize, s.triangle_count());
}

#[test]
fn tags_survive_booleans() {
    let a = unit_cube().with_tag(1);
    let b = sphere(Vec3::new(1.0, 0.0, 0.0), 0.8, 16, 8).with_tag(2);
    let s = a.subtract(&b);
    let tags: std::collections::BTreeSet<u32> = s.polygons.iter().map(|p| p.shared).collect();
    assert_eq!(tags.into_iter().collect::<Vec<_>>(), vec![1, 2]);
}

#[test]
fn high_resolution_does_not_overflow() {
    // A convex mesh degenerates the BSP into a chain as deep as its polygon
    // count; the iterative implementation must handle this on a small stack.
    let handle = std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(|| {
            let s = sphere(Vec3::ZERO, 1.0, 128, 64);
            let t = sphere(Vec3::new(0.5, 0.0, 0.0), 1.0, 128, 64);
            s.subtract(&t).volume()
        })
        .unwrap();
    assert!(handle.join().unwrap() > 0.0);
}

#[test]
fn ffi_round_trip() {
    let a = ffi::geo_cube(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
    let b = ffi::geo_cube(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
    let u = ffi::geo_union(a, b);
    assert!(a != 0 && b != 0 && u != 0);
    assert!((ffi::geo_volume(u) - 15.0).abs() < 1e-9);

    let verts = ffi::geo_mesh(u) as usize;
    assert_eq!(ffi::geo_mesh_len(0) as usize, verts * 3);
    assert_eq!(ffi::geo_mesh_len(3) as usize, ffi::geo_triangle_count(u) as usize * 3);

    let mut bounds = [0.0f64; 6];
    assert_eq!(unsafe { ffi::geo_bounds(u, bounds.as_mut_ptr()) }, 1);
    assert_eq!(bounds, [-1.0, -1.0, -1.0, 2.0, 2.0, 2.0]);

    // Invalid handles fail softly.
    assert_eq!(ffi::geo_union(a, 9999), 0);
    assert!(ffi::geo_volume(0).is_nan());

    let live = ffi::geo_live_count();
    assert_eq!(ffi::geo_free(u), 1);
    assert_eq!(ffi::geo_free(u), 0);
    assert_eq!(ffi::geo_live_count(), live - 1);
    // Freed slots are reused.
    let c = ffi::geo_clone(a);
    assert_eq!(c, u);
}
