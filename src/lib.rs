//! geomium — constructive solid geometry compiled to WebAssembly.
//!
//! The Rust API ([`Solid`], [`primitives`], [`Mesh`]) is usable natively; the
//! `ffi` module exposes it to JavaScript as a handle-based C ABI with no
//! binding generator required.

pub mod csg;
pub mod ffi;
pub mod math;
pub mod mesh;
pub mod primitives;

pub use csg::{Bounds, Plane, Polygon, Solid, Vertex};
pub use math::{Mat4, Vec3};
pub use mesh::{to_stl, Mesh};
