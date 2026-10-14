//! Raw C-ABI exports consumed by `pkg/critica.js`.
//!
//! Solids live in a handle table inside the module; JavaScript only ever sees
//! `u32` handles (0 means "invalid / error"). Bulk data crosses the boundary
//! through linear memory: inputs via `geo_alloc`, outputs via the mesh and
//! byte buffers, which stay valid until the next `geo_mesh` / `geo_stl` call.

use crate::csg::Solid;
use crate::math::{Mat4, Vec3};
use crate::mesh::{self, Mesh};
use crate::primitives;
use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

#[derive(Default)]
struct Store {
    solids: Vec<Option<Solid>>,
    free: Vec<usize>,
    mesh: Mesh,
    bytes: Vec<u8>,
}

impl Store {
    fn insert(&mut self, solid: Solid) -> u32 {
        let idx = match self.free.pop() {
            Some(i) => {
                self.solids[i] = Some(solid);
                i
            }
            None => {
                self.solids.push(Some(solid));
                self.solids.len() - 1
            }
        };
        idx as u32 + 1
    }

    fn get(&self, handle: u32) -> Option<&Solid> {
        let idx = (handle as usize).checked_sub(1)?;
        self.solids.get(idx)?.as_ref()
    }

    fn remove(&mut self, handle: u32) -> bool {
        let Some(idx) = (handle as usize).checked_sub(1) else {
            return false;
        };
        match self.solids.get_mut(idx).and_then(Option::take) {
            Some(_) => {
                self.free.push(idx);
                true
            }
            None => false,
        }
    }
}

thread_local! {
    static STORE: RefCell<Store> = RefCell::new(Store::default());
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    STORE.with(|s| f(&mut s.borrow_mut()))
}

fn create(solid: Solid) -> u32 {
    with_store(|s| s.insert(solid))
}

/// Derives a new solid from an existing one.
fn map(handle: u32, f: impl FnOnce(&Solid) -> Solid) -> u32 {
    with_store(|s| match s.get(handle) {
        Some(solid) => {
            let out = f(solid);
            s.insert(out)
        }
        None => 0,
    })
}

/// Combines two existing solids into a new one.
fn combine(a: u32, b: u32, f: impl FnOnce(&Solid, &Solid) -> Solid) -> u32 {
    with_store(|s| match (s.get(a), s.get(b)) {
        (Some(x), Some(y)) => {
            let out = f(x, y);
            s.insert(out)
        }
        _ => 0,
    })
}

fn query<R>(handle: u32, default: R, f: impl FnOnce(&Solid) -> R) -> R {
    with_store(|s| s.get(handle).map(f).unwrap_or(default))
}

const ALIGN: usize = 8;

// ---- memory ---------------------------------------------------------------

/// Allocates `len` bytes (8-byte aligned) for passing input data.
#[no_mangle]
pub extern "C" fn geo_alloc(len: usize) -> *mut u8 {
    match Layout::from_size_align(len.max(1), ALIGN) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees memory obtained from `geo_alloc` with the same `len`.
///
/// # Safety
/// `ptr` must come from `geo_alloc(len)` and not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn geo_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), ALIGN));
    }
}

// ---- primitives -----------------------------------------------------------

#[no_mangle]
pub extern "C" fn geo_cube(cx: f64, cy: f64, cz: f64, rx: f64, ry: f64, rz: f64) -> u32 {
    create(primitives::cuboid(Vec3::new(cx, cy, cz), Vec3::new(rx, ry, rz)))
}

#[no_mangle]
pub extern "C" fn geo_sphere(cx: f64, cy: f64, cz: f64, r: f64, slices: u32, stacks: u32) -> u32 {
    create(primitives::sphere(Vec3::new(cx, cy, cz), r, slices, stacks))
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn geo_cylinder(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    r_start: f64,
    r_end: f64,
    slices: u32,
) -> u32 {
    create(primitives::frustum(
        Vec3::new(sx, sy, sz),
        Vec3::new(ex, ey, ez),
        r_start,
        r_end,
        slices,
    ))
}

/// Annular tube (plain cylinder when r_inner is 0), faces tagged per surface.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn geo_tube(
    sx: f64,
    sy: f64,
    sz: f64,
    ex: f64,
    ey: f64,
    ez: f64,
    r_inner: f64,
    r_outer: f64,
    slices: u32,
    tag_outer: u32,
    tag_inner: u32,
    tag_start: u32,
    tag_end: u32,
) -> u32 {
    create(primitives::tube(
        Vec3::new(sx, sy, sz),
        Vec3::new(ex, ey, ez),
        r_inner,
        r_outer,
        slices,
        [tag_outer, tag_inner, tag_start, tag_end],
    ))
}

#[no_mangle]
pub extern "C" fn geo_torus(
    cx: f64,
    cy: f64,
    cz: f64,
    major: f64,
    minor: f64,
    segments: u32,
    rings: u32,
) -> u32 {
    create(primitives::torus(Vec3::new(cx, cy, cz), major, minor, segments, rings))
}

/// Builds a solid from `pos_len` f64 coordinates and `idx_len` u32 indices.
///
/// # Safety
/// The pointers must reference valid, aligned arrays of the given lengths.
#[no_mangle]
pub unsafe extern "C" fn geo_from_triangles(
    positions: *const f64,
    pos_len: usize,
    indices: *const u32,
    idx_len: usize,
) -> u32 {
    if positions.is_null() || indices.is_null() {
        return 0;
    }
    let positions = std::slice::from_raw_parts(positions, pos_len);
    let indices = std::slice::from_raw_parts(indices, idx_len);
    create(primitives::from_triangles(positions, indices))
}

// ---- booleans -------------------------------------------------------------

#[no_mangle]
pub extern "C" fn geo_union(a: u32, b: u32) -> u32 {
    combine(a, b, Solid::union)
}

#[no_mangle]
pub extern "C" fn geo_subtract(a: u32, b: u32) -> u32 {
    combine(a, b, Solid::subtract)
}

#[no_mangle]
pub extern "C" fn geo_intersect(a: u32, b: u32) -> u32 {
    combine(a, b, Solid::intersect)
}

/// Polygons of both solids, no boolean (boundaries must not cross).
#[no_mangle]
pub extern "C" fn geo_merge(a: u32, b: u32) -> u32 {
    combine(a, b, Solid::merge)
}

#[no_mangle]
pub extern "C" fn geo_inverse(h: u32) -> u32 {
    map(h, Solid::inverse)
}

// ---- transforms -----------------------------------------------------------

#[no_mangle]
pub extern "C" fn geo_clone(h: u32) -> u32 {
    map(h, Solid::clone)
}

#[no_mangle]
pub extern "C" fn geo_translate(h: u32, x: f64, y: f64, z: f64) -> u32 {
    map(h, |s| s.translate(Vec3::new(x, y, z)))
}

#[no_mangle]
pub extern "C" fn geo_rotate(h: u32, ax: f64, ay: f64, az: f64, degrees: f64) -> u32 {
    map(h, |s| s.rotate(Vec3::new(ax, ay, az), degrees))
}

#[no_mangle]
pub extern "C" fn geo_scale(h: u32, x: f64, y: f64, z: f64) -> u32 {
    map(h, |s| s.scale(Vec3::new(x, y, z)))
}

/// Applies a column-major 4x4 matrix read from 16 f64 values at `m`.
///
/// # Safety
/// `m` must point to 16 valid, aligned f64 values.
#[no_mangle]
pub unsafe extern "C" fn geo_transform(h: u32, m: *const f64) -> u32 {
    if m.is_null() {
        return 0;
    }
    let mut elems = [0.0; 16];
    elems.copy_from_slice(std::slice::from_raw_parts(m, 16));
    map(h, |s| s.transform(&Mat4(elems)))
}

#[no_mangle]
pub extern "C" fn geo_tag(h: u32, tag: u32) -> u32 {
    map(h, |s| s.with_tag(tag))
}

// ---- lifetime -------------------------------------------------------------

/// Releases a solid. Returns 1 if the handle was live.
#[no_mangle]
pub extern "C" fn geo_free(h: u32) -> u32 {
    with_store(|s| s.remove(h) as u32)
}

/// Number of live solids (useful for leak checks).
#[no_mangle]
pub extern "C" fn geo_live_count() -> u32 {
    with_store(|s| (s.solids.len() - s.free.len()) as u32)
}

// ---- queries --------------------------------------------------------------

#[no_mangle]
pub extern "C" fn geo_polygon_count(h: u32) -> u32 {
    query(h, 0, |s| s.polygons.len() as u32)
}

#[no_mangle]
pub extern "C" fn geo_triangle_count(h: u32) -> u32 {
    query(h, 0, |s| s.triangle_count() as u32)
}

#[no_mangle]
pub extern "C" fn geo_volume(h: u32) -> f64 {
    query(h, f64::NAN, Solid::volume)
}

#[no_mangle]
pub extern "C" fn geo_surface_area(h: u32) -> f64 {
    query(h, f64::NAN, Solid::surface_area)
}

/// Writes `[minX, minY, minZ, maxX, maxY, maxZ]` to `out`. Returns 0 if the
/// solid is empty or the handle is invalid.
///
/// # Safety
/// `out` must point to space for 6 aligned f64 values.
#[no_mangle]
pub unsafe extern "C" fn geo_bounds(h: u32, out: *mut f64) -> u32 {
    if out.is_null() {
        return 0;
    }
    match query(h, None, Solid::bounds) {
        Some(b) => {
            let dst = std::slice::from_raw_parts_mut(out, 6);
            dst.copy_from_slice(&[b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
            1
        }
        None => 0,
    }
}

// ---- export ---------------------------------------------------------------

/// Triangulates a solid into the shared mesh buffer and returns its vertex
/// count. Read the arrays with `geo_mesh_ptr` / `geo_mesh_len`.
#[no_mangle]
pub extern "C" fn geo_mesh(h: u32) -> u32 {
    with_store(|s| {
        s.mesh = s.get(h).map(Mesh::from_solid).unwrap_or_default();
        s.mesh.vertex_count() as u32
    })
}

/// Pointer to a mesh buffer: 0 = positions (f32), 1 = normals (f32),
/// 2 = tags (u32), 3 = indices (u32).
#[no_mangle]
pub extern "C" fn geo_mesh_ptr(kind: u32) -> *const u8 {
    with_store(|s| match kind {
        0 => s.mesh.positions.as_ptr() as *const u8,
        1 => s.mesh.normals.as_ptr() as *const u8,
        2 => s.mesh.tags.as_ptr() as *const u8,
        3 => s.mesh.indices.as_ptr() as *const u8,
        _ => std::ptr::null(),
    })
}

/// Element count of a mesh buffer (see `geo_mesh_ptr`).
#[no_mangle]
pub extern "C" fn geo_mesh_len(kind: u32) -> u32 {
    with_store(|s| match kind {
        0 => s.mesh.positions.len() as u32,
        1 => s.mesh.normals.len() as u32,
        2 => s.mesh.tags.len() as u32,
        3 => s.mesh.indices.len() as u32,
        _ => 0,
    })
}

/// Encodes a solid as binary STL into the byte buffer; returns its length.
#[no_mangle]
pub extern "C" fn geo_stl(h: u32) -> u32 {
    with_store(|s| {
        s.bytes = s.get(h).map(mesh::to_stl).unwrap_or_default();
        s.bytes.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn geo_bytes_ptr() -> *const u8 {
    with_store(|s| s.bytes.as_ptr())
}
