//! Minimal linear algebra: 3D vectors and affine 4x4 matrices.

use std::ops::{Add, Div, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Vec3 { x, y, z }
    }

    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    /// Returns the unit vector, or zero if the length is (nearly) zero.
    pub fn normalize(self) -> Vec3 {
        let len = self.length();
        if len > 1e-300 {
            self / len
        } else {
            Vec3::ZERO
        }
    }

    pub fn lerp(self, o: Vec3, t: f64) -> Vec3 {
        self + (o - self) * t
    }

    pub fn min(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }

    pub fn max(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }

    /// Any unit vector perpendicular to `self` (which must be non-zero).
    pub fn any_perpendicular(self) -> Vec3 {
        let helper = if self.x.abs() < 0.9 {
            Vec3::new(1.0, 0.0, 0.0)
        } else {
            Vec3::new(0.0, 1.0, 0.0)
        };
        self.cross(helper).normalize()
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Div<f64> for Vec3 {
    type Output = Vec3;
    fn div(self, s: f64) -> Vec3 {
        Vec3::new(self.x / s, self.y / s, self.z / s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// Column-major 4x4 matrix (same layout as WebGL / glMatrix / three.js `elements`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4(pub [f64; 16]);

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4([
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]);

    #[inline]
    fn at(&self, row: usize, col: usize) -> f64 {
        self.0[col * 4 + row]
    }

    pub fn translation(t: Vec3) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.0[12] = t.x;
        m.0[13] = t.y;
        m.0[14] = t.z;
        m
    }

    pub fn scaling(s: Vec3) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.0[0] = s.x;
        m.0[5] = s.y;
        m.0[10] = s.z;
        m
    }

    /// Rotation of `degrees` around `axis` (right-handed).
    pub fn rotation(axis: Vec3, degrees: f64) -> Mat4 {
        let a = axis.normalize();
        let (s, c) = degrees.to_radians().sin_cos();
        let t = 1.0 - c;
        let (x, y, z) = (a.x, a.y, a.z);
        Mat4([
            t * x * x + c,
            t * x * y + s * z,
            t * x * z - s * y,
            0.0,
            t * x * y - s * z,
            t * y * y + c,
            t * y * z + s * x,
            0.0,
            t * x * z + s * y,
            t * y * z - s * x,
            t * z * z + c,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
        ])
    }

    pub fn mul(&self, o: &Mat4) -> Mat4 {
        let mut r = [0.0; 16];
        for col in 0..4 {
            for row in 0..4 {
                r[col * 4 + row] = (0..4).map(|k| self.at(row, k) * o.at(k, col)).sum();
            }
        }
        Mat4(r)
    }

    pub fn transform_point(&self, p: Vec3) -> Vec3 {
        let x = self.at(0, 0) * p.x + self.at(0, 1) * p.y + self.at(0, 2) * p.z + self.at(0, 3);
        let y = self.at(1, 0) * p.x + self.at(1, 1) * p.y + self.at(1, 2) * p.z + self.at(1, 3);
        let z = self.at(2, 0) * p.x + self.at(2, 1) * p.y + self.at(2, 2) * p.z + self.at(2, 3);
        let w = self.at(3, 0) * p.x + self.at(3, 1) * p.y + self.at(3, 2) * p.z + self.at(3, 3);
        if w != 0.0 && w != 1.0 {
            Vec3::new(x / w, y / w, z / w)
        } else {
            Vec3::new(x, y, z)
        }
    }

    /// Determinant of the upper-left 3x3 (the linear part).
    pub fn det3(&self) -> f64 {
        let m = |r, c| self.at(r, c);
        m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1))
            - m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0))
            + m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0))
    }

    /// Transforms a surface normal using the cofactor matrix of the linear part,
    /// which equals det * inverse-transpose. Multiplying by sign(det) keeps the
    /// normal pointing outward for mirroring transforms.
    pub fn transform_normal(&self, n: Vec3) -> Vec3 {
        let m = |r, c| self.at(r, c);
        let c00 = m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1);
        let c01 = m(1, 2) * m(2, 0) - m(1, 0) * m(2, 2);
        let c02 = m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0);
        let c10 = m(0, 2) * m(2, 1) - m(0, 1) * m(2, 2);
        let c11 = m(0, 0) * m(2, 2) - m(0, 2) * m(2, 0);
        let c12 = m(0, 1) * m(2, 0) - m(0, 0) * m(2, 1);
        let c20 = m(0, 1) * m(1, 2) - m(0, 2) * m(1, 1);
        let c21 = m(0, 2) * m(1, 0) - m(0, 0) * m(1, 2);
        let c22 = m(0, 0) * m(1, 1) - m(0, 1) * m(1, 0);
        let v = Vec3::new(
            c00 * n.x + c01 * n.y + c02 * n.z,
            c10 * n.x + c11 * n.y + c12 * n.z,
            c20 * n.x + c21 * n.y + c22 * n.z,
        );
        let sign = if self.det3() < 0.0 { -1.0 } else { 1.0 };
        (v * sign).normalize()
    }
}
