// Small WebGL2 mesh viewer shared by the builder and the script playground.
//
//   const viewer = createViewer(canvas, { onPick(tag, event) {} });
//   viewer.setMesh(mesh, colors, open, leaves);  // mesh from Solid.toMesh(), colors: rgb per vertex,
//                                   // open: optional 1/0 per vertex for faces drawn as open sides,
//                                   // leaves: optional second tag per vertex, reported with picks
//   viewer.setGhost(mesh | null);   // translucent x-ray overlay
//   viewer.fit(bounds);
//   viewer.setUp("z");              // which model axis points up on screen ("y" default)
//   viewer.setTheme("light");       // background and grid colors: "dark" (default) or "light"
//   viewer.setGizmos({ planes, arrows, surfaces });  // plane sheets, 3D arrows and translucent
//       surface shells (model coordinates): planes: [{ polygon: [[x,y,z]…], normal, color, tag }],
//       arrows: [{ from, dir, length, color, tag }], surfaces: [{ positions, normals, indices, color, tag }],
//       marks: [{ center, normal, u, size, plus, color, tag }] (flat + / − signs; u = in-plane direction),
//       wires: [{ from, to, color }] (construction lines, faint where hidden)
//   viewer.setClip(planes);         // cutaway: hide the region where n·p > d for every plane
//                                   // (0–3 planes {n, d}, model coordinates); [] shows everything
//
// Orbit: left-drag. Pan: right-drag or shift+drag. Zoom: wheel.
// A click (press without dragging) reports the tag under the cursor (0 = none)
// and its leaf tag: onPick(tag, event, leaf);
// a right click without dragging reports it to `onContext` (right-drag pans).

const VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec3 aColor; in float aTag; in float aOpen; in float aLeaf;
uniform mat4 uMvp; uniform mat4 uView; uniform mat4 uModel; uniform highp int uMode; uniform float uBias;
out vec3 vNormal; out vec3 vColor; out vec3 vPos; flat out float vTag; out float vOpen;
void main() {
  vNormal = mat3(uView) * mat3(uModel) * aNormal; vColor = aColor; vTag = uMode == 5 ? aLeaf : aTag; vPos = aPos; vOpen = aOpen;
  gl_Position = uMvp * uModel * vec4(aPos, 1.0);
  gl_Position.z -= uBias * gl_Position.w; // nudge toward the camera (lines over coincident faces)
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vColor; in vec3 vPos; flat in float vTag; in float vOpen;
uniform highp int uMode; uniform vec4 uTint; uniform vec3 uBg;
uniform int uClipN; uniform vec4 uClip[3];
out vec4 outColor;
// Cutaway: the removed region is the intersection of the half-spaces n·p > d.
bool clipped() {
  if (uClipN == 0) return false;
  for (int i = 0; i < 3; i++) {
    if (i >= uClipN) break;
    if (dot(uClip[i].xyz, vPos) <= uClip[i].w) return false;
  }
  return true;
}
void main() {
  if (uMode != 3 && clipped()) discard;
  if (uMode == 0 && uClipN > 0 && !gl_FrontFacing) {
    // Inside of a cut solid: draw it as a flat, lightly hatched section face.
    float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 7.0));
    outColor = vec4(vColor * mix(0.66, 0.74, hatch), 1.0);
    return;
  }
  if (uMode == 1 || uMode == 5) { // pick: encode tag (5: leaf tag) as rgb
    float t = vTag;
    outColor = vec4(mod(t, 256.0), mod(floor(t / 256.0), 256.0), floor(t / 65536.0), 255.0) / 255.0;
    return;
  }
  if (uMode == 3) { outColor = vec4(vColor, 1.0); return; } // unlit lines
  if (uMode == 6) { outColor = vec4(vColor, uTint.a); return; } // unlit lines, translucent
  if (uMode == 4) { // translucent sheets (plane gizmos), lit from both sides
    vec3 sn = normalize(vNormal);
    float lit = 0.6 + 0.4 * abs(dot(sn, normalize(vec3(0.4, 0.7, 0.6))));
    outColor = vec4(vColor * lit, uTint.a);
    return;
  }
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.4))), 0.0) * 0.3;
  float rim = pow(1.0 - abs(n.z), 2.0);
  if (uMode == 2) { outColor = vec4(uTint.rgb * (0.5 + 0.5 * key) , uTint.a * (0.5 + rim)); return; }
  vec3 lit = vColor * (0.22 + 0.75 * key + fill);
  if (uMode == 0 && vOpen > 0.5) {
    // Open side: the region goes on past the world box, which only cuts it for
    // display. Faded, with wide diagonal stripes, so it doesn't read as a wall.
    float stripe = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) / 18.0));
    lit = mix(lit, uBg, mix(0.5, 0.78, stripe));
  }
  outColor = vec4(lit, 1.0);
}`;

const mul = (a, b) => {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  return r;
};

const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

const lookAt = (eye, at) => {
  const z = norm(sub(eye, at));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return {
    matrix: new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]),
    right: x,
    up: y,
  };
};

const THEMES = {
  dark: { background: [0.078, 0.086, 0.102], gridMinor: [0.17, 0.19, 0.22] },
  light: { background: [0.925, 0.933, 0.945], gridMinor: [0.78, 0.8, 0.83] },
};

export function createViewer(canvas, { onPick, onContext, theme: initialTheme = "dark", grid = true } = {}) {
  let theme = THEMES[initialTheme] ?? THEMES.dark;
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) throw new Error("WebGL2 is not available in this browser");

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const u = Object.fromEntries(["uMvp", "uView", "uModel", "uMode", "uTint", "uClipN", "uClip", "uBg", "uBias"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const attribs = [
    ["aPos", 3],
    ["aNormal", 3],
    ["aColor", 3],
    ["aTag", 1],
    ["aOpen", 1],
    ["aLeaf", 1],
  ];

  // A drawable: VAO + one buffer per attribute + optional index buffer.
  const makeDrawable = (names) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = {};
    for (const [name, size] of attribs) {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) continue;
      if (!names.includes(name)) {
        gl.disableVertexAttribArray(loc);
        continue;
      }
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      buffers[name] = b;
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    return {
      vao,
      count: 0,
      upload(data, indices) {
        gl.bindVertexArray(vao);
        for (const [name, array] of Object.entries(data)) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buffers[name]);
          gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
        }
        if (indices) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
          this.count = indices.length;
        }
        gl.bindVertexArray(null);
      },
    };
  };

  const solid = makeDrawable(["aPos", "aNormal", "aColor", "aTag", "aOpen", "aLeaf"]);
  const ghost = makeDrawable(["aPos", "aNormal"]);
  const lines = makeDrawable(["aPos", "aColor"]);
  // Gizmos: translucent plane sheets, their outlines, and 3D arrows.
  const gizmoSheets = makeDrawable(["aPos", "aNormal", "aColor", "aTag"]);
  const gizmoArrows = makeDrawable(["aPos", "aNormal", "aColor", "aTag"]);
  const gizmoMarks = makeDrawable(["aPos", "aNormal", "aColor", "aTag"]); // + / − signs, seen from their side only
  const gizmoLines = makeDrawable(["aPos", "aColor"]);
  const gizmoWires = makeDrawable(["aPos", "aColor"]);
  let gizmoWireCount = 0;
  let gizmoLineCount = 0;
  let lineCount = 0;

  let center = [0, 0, 0];
  let radius = 2;
  let yaw = 0.7;
  let pitch = 0.45;
  let dist = 3;
  let camera = null;
  let gridSize = 0;
  // Model → display (Y-up) matrix. For Z-up models: (x, y, z) → (x, z, -y).
  const MODEL_IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const MODEL_Z_UP = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  let model = MODEL_IDENTITY;

  function buildGrid(size) {
    // Grid on y = 0 with a step that keeps ~10-20 lines per side.
    const step = 10 ** Math.floor(Math.log10(size / 2));
    const n = Math.ceil(size / step);
    const pos = [];
    const col = [];
    const line = (a, b, c) => {
      pos.push(...a, ...b);
      col.push(...c, ...c);
    };
    const minor = theme.gridMinor;
    // The grid lives in display space (screen up = display Y). Color its axis
    // lines by the model axis they show, as in the forms: X red, Y green, Z blue.
    // With Z up, display Y is model Z and display Z is model −Y.
    const RED = [0.85, 0.3, 0.3];
    const GREEN = [0.35, 0.8, 0.35];
    const BLUE = [0.25, 0.4, 0.85];
    const zUp = model === MODEL_Z_UP;
    const depthAxis = zUp ? GREEN : BLUE; // the horizontal line running into the screen
    const upAxis = zUp ? BLUE : GREEN; // the vertical stub
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      const e = n * step;
      line([v, 0, -e], [v, 0, e], i === 0 ? depthAxis : minor);
      line([-e, 0, v], [e, 0, v], i === 0 ? RED : minor);
    }
    line([0, 0, 0], [0, step * 2, 0], upAxis);
    lines.upload({ aPos: new Float32Array(pos), aColor: new Float32Array(col) });
    lineCount = pos.length / 3;
  }

  gridSize = 4;
  buildGrid(gridSize);

  function resize() {
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, (canvas.clientWidth * dpr) | 0);
    const h = Math.max(1, (canvas.clientHeight * dpr) | 0);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return [w, h];
  }

  function eyePosition() {
    const d = radius * dist;
    return [
      center[0] + d * Math.cos(pitch) * Math.sin(yaw),
      center[1] + d * Math.sin(pitch),
      center[2] + d * Math.cos(pitch) * Math.cos(yaw),
    ];
  }

  function matrices(w, h) {
    const d = radius * dist;
    const eye = eyePosition();
    camera = lookAt(eye, center);
    return { view: camera.matrix, mvp: mul(perspective(0.8, w / h, d * 0.01, d * 20), camera.matrix) };
  }

  let clipPlanes = [];
  function applyClip() {
    gl.uniform1i(u.uClipN, clipPlanes.length);
    const data = new Float32Array(12);
    clipPlanes.forEach((p, i) => data.set([...p.n, p.d], i * 4));
    gl.uniform4fv(u.uClip, data);
  }

  function drawScene(mode) {
    gl.useProgram(prog);
    applyClip();
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform1i(u.uMode, mode);
    gl.uniform3fv(u.uBg, theme.background);
    gl.bindVertexArray(solid.vao);
    if (!solid.count) return;
    // Open sides lie on the world box, where finite content often has real
    // faces too: push them back so the real faces win the depth test.
    const closed = solid.openStart ?? solid.count;
    drawRange(0, closed);
    if (closed < solid.count) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(2, 8);
      drawRange(closed, solid.count - closed, true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
  }

  function drawRange(first, count, offset = false) {
    const at = first * 4;
    if (!count) return;
    if (!clipPlanes.length) {
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, at);
      return;
    }
    // With a cutaway, the insides of cut solids (back faces) act as section
    // faces. Where two cells share a wall, the cut cell's inside and its
    // neighbour's outside are coplanar: draw back faces in a second pass,
    // nudged toward the camera, so the cut cell wins instead of z-fighting.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, at);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, at);
    if (offset) gl.polygonOffset(2, 8);
    else gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.cullFace(gl.BACK);
    gl.disable(gl.CULL_FACE);
  }

  let frame = 0;
  function draw() {
    frame = 0;
    const [w, h] = resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(...theme.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { view, mvp } = matrices(w, h);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uMvp, false, mvp);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    if (grid && lineCount) {
      gl.uniformMatrix4fv(u.uModel, false, MODEL_IDENTITY);
      gl.uniform1i(u.uMode, 3);
      gl.bindVertexArray(lines.vao);
      gl.drawArrays(gl.LINES, 0, lineCount);
    }
    drawScene(0);
    drawGizmos(0);

    if (ghost.count) {
      // X-ray: no depth test, so hidden operands (e.g. subtracted cutters) show through.
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.CULL_FACE);
      gl.uniform1i(u.uMode, 2);
      gl.uniform4f(u.uTint, 1.0, 0.82, 0.4, 0.22);
      gl.bindVertexArray(ghost.vao);
      gl.drawElements(gl.TRIANGLES, ghost.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
      // Restore: picking clears and tests depth with this same context.
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  /** Arrows (opaque, shaded), sheet outlines, then translucent sheets. Mode 1 = picking. */
  function drawGizmos(mode) {
    if (!gizmoArrows.count && !gizmoSheets.count && !gizmoMarks.count && !gizmoWireCount) return;
    gl.useProgram(prog);
    applyClip();
    gl.uniformMatrix4fv(u.uModel, false, model);
    if (gizmoArrows.count) {
      gl.uniform1i(u.uMode, mode === 1 ? 1 : 0);
      gl.bindVertexArray(gizmoArrows.vao);
      gl.drawElements(gl.TRIANGLES, gizmoArrows.count, gl.UNSIGNED_INT, 0);
    }
    if (gizmoMarks.count) {
      gl.uniform1i(u.uMode, mode === 1 ? 1 : 0);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.bindVertexArray(gizmoMarks.vao);
      gl.drawElements(gl.TRIANGLES, gizmoMarks.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
    }
    if (mode === 1) {
      if (gizmoSheets.count) {
        gl.bindVertexArray(gizmoSheets.vao);
        gl.drawElements(gl.TRIANGLES, gizmoSheets.count, gl.UNSIGNED_INT, 0);
      }
      gl.bindVertexArray(null);
      return;
    }
    if (gizmoLineCount) {
      gl.uniform1i(u.uMode, 3);
      gl.bindVertexArray(gizmoLines.vao);
      gl.drawArrays(gl.LINES, 0, gizmoLineCount);
    }
    if (gizmoWireCount) {
      // Construction lines: solid where visible, faint behind solids.
      gl.bindVertexArray(gizmoWires.vao);
      gl.uniform1i(u.uMode, 3);
      gl.uniform1f(u.uBias, 2e-4);
      gl.drawArrays(gl.LINES, 0, gizmoWireCount);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.depthFunc(gl.GREATER);
      gl.uniform1i(u.uMode, 6);
      gl.uniform4f(u.uTint, 1, 1, 1, 0.4);
      gl.drawArrays(gl.LINES, 0, gizmoWireCount);
      gl.uniform1f(u.uBias, 0);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    if (gizmoSheets.count) {
      // Translucent and without depth writes, so nothing behind is hidden.
      // Parts behind solids are drawn too, fainter, so a surface inside a
      // cell stays visible.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(u.uMode, 4);
      gl.bindVertexArray(gizmoSheets.vao);
      gl.depthFunc(gl.GREATER);
      gl.uniform4f(u.uTint, 1, 1, 1, 0.12);
      gl.drawElements(gl.TRIANGLES, gizmoSheets.count, gl.UNSIGNED_INT, 0);
      gl.depthFunc(gl.LESS);
      gl.uniform4f(u.uTint, 1, 1, 1, 0.28);
      gl.drawElements(gl.TRIANGLES, gizmoSheets.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /** A flat sign lying in the plane (u, n × u) at `center`, visible from the `normal` side: a bar along u, plus one across for "+". */
  function markMesh({ center, normal, u, size, plus, color, tag = 0 }, out) {
    const v = cross(normal, u);
    const bar = (a, b) => {
      const base = out.pos.length / 3;
      const w = size * 0.14;
      for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        out.pos.push(...center.map((c, i) => c + a[i] * s * size * 0.5 + b[i] * t * w));
        out.nrm.push(...normal);
        out.col.push(...color);
        out.tag.push(tag);
      }
      // Counter-clockwise seen from the normal's side, so culling hides the back.
      if (dot(cross(a, b), normal) >= 0) out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    bar(u, v);
    if (plus) bar(v, u);
  }

  /** Triangle mesh of an arrow: shaft cylinder + cone head, along unit `dir`. */
  function arrowMesh(from, dir, length, color, tag, out) {
    const seg = 14;
    const r = length * 0.045;
    const head = length * 0.3;
    const shaftEnd = from.map((v, i) => v + dir[i] * (length - head));
    const tip = from.map((v, i) => v + dir[i] * length);
    const helper = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (v) => {
      const l = Math.hypot(...v);
      return v.map((x) => x / l);
    };
    const u = norm(cross(dir, helper));
    const w = cross(dir, u);
    const ring = (c, radius, k) => {
      const a = (k / seg) * Math.PI * 2;
      const off = u.map((x, i) => (x * Math.cos(a) + w[i] * Math.sin(a)) * radius);
      return { p: c.map((v, i) => v + off[i]), n: norm(off) };
    };
    const vert = (p, n) => {
      out.pos.push(...p);
      out.nrm.push(...n);
      out.col.push(...color);
      out.tag.push(tag);
      return out.pos.length / 3 - 1;
    };
    const slope = (2.2 * r) / head; // cone side normals tilt toward the tip
    for (let k = 0; k < seg; k++) {
      const a0 = ring(from, r, k);
      const a1 = ring(from, r, k + 1);
      const b0 = ring(shaftEnd, r, k);
      const b1 = ring(shaftEnd, r, k + 1);
      const i0 = vert(a0.p, a0.n);
      const i1 = vert(a1.p, a1.n);
      const i2 = vert(b1.p, b1.n);
      const i3 = vert(b0.p, b0.n);
      out.idx.push(i0, i1, i2, i0, i2, i3);
      // Head: base disk and cone.
      const h0 = ring(shaftEnd, 2.2 * r, k);
      const h1 = ring(shaftEnd, 2.2 * r, k + 1);
      const back = dir.map((x) => -x);
      const c = vert(shaftEnd, back);
      out.idx.push(c, vert(h1.p, back), vert(h0.p, back));
      const n0 = norm(h0.n.map((x, i) => x + dir[i] * slope));
      const n1 = norm(h1.n.map((x, i) => x + dir[i] * slope));
      out.idx.push(vert(h0.p, n0), vert(h1.p, n1), vert(tip, norm(n0.map((x, i) => x + n1[i]))));
    }
  }

  // ---- picking ---------------------------------------------------------------
  let fbo = null;
  let fboSize = [0, 0];
  let colorRb = null;
  let depthRb = null;
  /** Tag under the cursor (or, with `leaf`, the solid's leaf tag there). */
  function pick(clientX, clientY, leaf = false) {
    if (!solid.count && !gizmoSheets.count && !gizmoArrows.count && !gizmoMarks.count) return 0;
    const [w, h] = resize();
    if (!fbo || fboSize[0] !== w || fboSize[1] !== h) {
      fbo ??= gl.createFramebuffer();
      colorRb ??= gl.createRenderbuffer();
      depthRb ??= gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, colorRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      fboSize = [w, h];
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * w);
    const y = Math.floor((1 - (clientY - rect.top) / rect.height) * h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { view, mvp } = matrices(w, h);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uMvp, false, mvp);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    drawScene(leaf ? 5 : 1);
    drawGizmos(1);
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px[3] ? px[0] + px[1] * 256 + px[2] * 65536 : 0;
  }

  // ---- input -----------------------------------------------------------------
  let drag = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    drag = null;
    if (moved < 4 && e.button === 0 && onPick) {
      const tag = pick(e.clientX, e.clientY);
      onPick(tag, e, tag ? pick(e.clientX, e.clientY, true) : 0);
    }
    if (moved < 4 && e.button === 2 && onContext) {
      const tag = pick(e.clientX, e.clientY);
      onContext(tag, e, tag ? pick(e.clientX, e.clientY, true) : 0);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan && camera) {
      const s = (radius * dist * 1.2) / canvas.clientHeight;
      center = center.map((c, i) => c - camera.right[i] * dx * s + camera.up[i] * dy * s);
    } else {
      yaw -= dx * 0.01;
      pitch = Math.max(-1.55, Math.min(1.55, pitch + dy * 0.01));
    }
    redraw();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      dist = Math.max(0.2, Math.min(40, dist * Math.exp(e.deltaY * 0.001)));
      redraw();
    },
    { passive: false },
  );
  new ResizeObserver(redraw).observe(canvas);

  return {
    /** Uploads a mesh. `colors` is rgb per vertex (defaults to a neutral blue); `open` flags open-side vertices. */
    setMesh(mesh, colors, open, leaves) {
      const n = mesh.positions.length / 3;
      if (!colors) {
        colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) colors.set([0.42, 0.71, 1.0], i * 3);
      }
      // Closed triangles first, then open ones (drawn with a depth offset).
      let indices = mesh.indices;
      solid.openStart = undefined;
      if (open) {
        const closed = [];
        const opened = [];
        for (let t = 0; t < indices.length; t += 3) (open[indices[t]] ? opened : closed).push(indices[t], indices[t + 1], indices[t + 2]);
        if (opened.length) {
          indices = Uint32Array.from([...closed, ...opened]);
          solid.openStart = closed.length;
        }
      }
      solid.upload(
        { aPos: mesh.positions, aNormal: mesh.normals, aColor: colors, aTag: Float32Array.from(mesh.tags), aOpen: open ?? new Float32Array(n), aLeaf: leaves ? Float32Array.from(leaves) : Float32Array.from(mesh.tags) },
        indices,
      );
      redraw();
    },
    /** Translucent overlay drawn through everything; pass null to clear. */
    setGhost(mesh) {
      if (mesh) ghost.upload({ aPos: mesh.positions, aNormal: mesh.normals }, mesh.indices);
      else ghost.count = 0;
      redraw();
    },
    /** Plane sheets (with outlines), 3D arrows and surface shells, in model coordinates; tags make them pickable. */
    setGizmos({ planes = [], arrows = [], surfaces = [], marks = [], wires = [] } = {}) {
      const sheet = { pos: [], nrm: [], col: [], tag: [], idx: [] };
      const outline = { pos: [], col: [] };
      for (const p of planes) {
        const base = sheet.pos.length / 3;
        for (const v of p.polygon) {
          sheet.pos.push(...v);
          sheet.nrm.push(...p.normal);
          sheet.col.push(...p.color);
          sheet.tag.push(p.tag ?? 0);
        }
        for (let k = 1; k + 1 < p.polygon.length; k++) sheet.idx.push(base, base + k, base + k + 1);
        p.polygon.forEach((v, k) => {
          outline.pos.push(...v, ...p.polygon[(k + 1) % p.polygon.length]);
          outline.col.push(...p.color, ...p.color);
        });
      }
      for (const m of surfaces) {
        const base = sheet.pos.length / 3;
        const n = m.positions.length / 3;
        for (let i = 0; i < n; i++) {
          sheet.pos.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
          sheet.nrm.push(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
          sheet.col.push(...m.color);
          sheet.tag.push(m.tag ?? 0);
        }
        for (const i of m.indices) sheet.idx.push(base + i);
      }
      const arrow = { pos: [], nrm: [], col: [], tag: [], idx: [] };
      for (const a of arrows) arrowMesh(a.from, a.dir, a.length, a.color, a.tag ?? 0, arrow);
      const mark = { pos: [], nrm: [], col: [], tag: [], idx: [] };
      for (const m of marks) markMesh(m, mark);
      const upload = (d, m) =>
        d.upload({ aPos: new Float32Array(m.pos), aNormal: new Float32Array(m.nrm), aColor: new Float32Array(m.col), aTag: new Float32Array(m.tag) }, new Uint32Array(m.idx));
      upload(gizmoSheets, sheet);
      upload(gizmoArrows, arrow);
      upload(gizmoMarks, mark);
      gizmoLines.upload({ aPos: new Float32Array(outline.pos), aColor: new Float32Array(outline.col) });
      gizmoLineCount = outline.pos.length / 3;
      const wire = { pos: [], col: [] };
      for (const w of wires) {
        wire.pos.push(...w.from, ...w.to);
        wire.col.push(...w.color, ...w.color);
      }
      gizmoWires.upload({ aPos: new Float32Array(wire.pos), aColor: new Float32Array(wire.col) });
      gizmoWireCount = wire.pos.length / 3;
      redraw();
    },
    /** Switches background and grid colors ("dark" or "light"). */
    setTheme(name) {
      const next = THEMES[name] ?? THEMES.dark;
      if (next === theme) return;
      theme = next;
      buildGrid(gridSize);
      redraw();
    },
    /** The camera ray through a pointer position: { origin, dir } in model coordinates. */
    rayAt(clientX, clientY) {
      const [w, h] = resize();
      matrices(w, h);
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((clientY - rect.top) / rect.height) * 2;
      const t = Math.tan(0.8 / 2);
      const eye = eyePosition();
      const fwd = norm(sub(center, eye));
      let dir = norm(fwd.map((f, i) => f + camera.right[i] * x * t * (w / h) + camera.up[i] * y * t));
      let origin = eye;
      if (model === MODEL_Z_UP) {
        // Display (x, y, z) is model (x, z, −y): invert it.
        origin = [origin[0], -origin[2], origin[1]];
        dir = [dir[0], -dir[2], dir[1]];
      }
      return { origin, dir };
    },
    /** Camera position in model coordinates. */
    eye() {
      const [x, y, z] = eyePosition();
      // Inverse of the display mapping (x, y, z) → (x, z, −y) used for Z-up models.
      return model === MODEL_Z_UP ? [x, -z, y] : [x, y, z];
    },
    /** Cutaway: hides the region where n·p > d for every given plane (model coordinates). */
    setClip(planes = []) {
      clipPlanes = planes.slice(0, 3);
      redraw();
    },
    /** Sets which model axis points up on screen: "y" (default) or "z". */
    setUp(axis) {
      const next = axis === "z" ? MODEL_Z_UP : MODEL_IDENTITY;
      if (next !== model) {
        model = next;
        buildGrid(gridSize); // axis colors depend on which model axis is up
        redraw();
      }
    },
    /** Frames the camera on `{ min, max }` bounds (model coordinates). */
    fit(bounds) {
      if (!bounds) return;
      if (model === MODEL_Z_UP) {
        // Display bounds of the model box under (x, y, z) → (x, z, -y).
        bounds = { min: [bounds.min[0], bounds.min[2], -bounds.max[1]], max: [bounds.max[0], bounds.max[2], -bounds.min[1]] };
      }
      center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
      radius = Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i])) / 2 || 1;
      dist = 3;
      const size = Math.max(4, radius * 4);
      if (Math.abs(size - gridSize) / size > 0.5) {
        gridSize = size;
        buildGrid(size);
      }
      redraw();
    },
    redraw,
  };
}
