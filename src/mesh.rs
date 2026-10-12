//! Conversion of solids into GPU-friendly triangle meshes and STL files.

use crate::csg::Solid;

/// Indexed triangle mesh with per-vertex normals and per-vertex tags.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    /// xyz triplets.
    pub positions: Vec<f32>,
    /// xyz triplets, unit length.
    pub normals: Vec<f32>,
    /// The `shared` tag of the polygon each vertex came from.
    pub tags: Vec<u32>,
    /// Triangle list, counter-clockwise from outside.
    pub indices: Vec<u32>,
}

impl Mesh {
    /// Fan-triangulates every (convex) polygon of `solid`.
    pub fn from_solid(solid: &Solid) -> Mesh {
        let mut mesh = Mesh::default();
        for p in &solid.polygons {
            let base = (mesh.positions.len() / 3) as u32;
            for v in &p.vertices {
                mesh.positions
                    .extend([v.pos.x as f32, v.pos.y as f32, v.pos.z as f32]);
                mesh.normals
                    .extend([v.normal.x as f32, v.normal.y as f32, v.normal.z as f32]);
                mesh.tags.push(p.shared);
            }
            for k in 1..p.vertices.len() as u32 - 1 {
                mesh.indices.extend([base, base + k, base + k + 1]);
            }
        }
        mesh
    }

    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

/// Encodes `solid` as a binary STL file.
pub fn to_stl(solid: &Solid) -> Vec<u8> {
    let tri_count = solid.triangle_count();
    let mut out = Vec::with_capacity(84 + tri_count * 50);
    let mut header = [0u8; 80];
    let label = b"geomium binary STL";
    header[..label.len()].copy_from_slice(label);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(tri_count as u32).to_le_bytes());
    let put =|out: &mut Vec<u8>, x: f64, y: f64, z: f64| {
        for c in [x, y, z] {
            out.extend_from_slice(&(c as f32).to_le_bytes());
        }
    };
    for p in &solid.polygons {
        let n = p.plane.normal;
        let a = p.vertices[0].pos;
        for w in p.vertices[1..].windows(2) {
            put(&mut out, n.x, n.y, n.z);
            put(&mut out, a.x, a.y, a.z);
            put(&mut out, w[0].pos.x, w[0].pos.y, w[0].pos.z);
            put(&mut out, w[1].pos.x, w[1].pos.y, w[1].pos.z);
            out.extend_from_slice(&0u16.to_le_bytes());
        }
    }
    out
}
