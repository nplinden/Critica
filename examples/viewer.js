// Small WebGL2 mesh viewer shared by the builder and the script playground.
//
//   const viewer = createViewer(canvas, { onPick(tag, event) {} });
//   viewer.setMesh(mesh, colors);   // mesh from Solid.toMesh(), colors: rgb per vertex
//   viewer.setGhost(mesh | null);   // translucent x-ray overlay
//   viewer.fit(bounds);
//   viewer.setUp("z");              // which model axis points up on screen ("y" default)
//   viewer.setTheme("light");       // background and grid colors: "dark" (default) or "light"
//   viewer.setClip(planes);         // cutaway: hide the region where n·p > d for every plane
//                                   // (0–3 planes {n, d}, model coordinates); [] shows everything
//
// Orbit: left-drag. Pan: right-drag or shift+drag. Zoom: wheel.
// A click (press without dragging) reports the tag under the cursor (0 = none).

const VS = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec3 aColor; in float aTag;
uniform mat4 uMvp; uniform mat4 uView; uniform mat4 uModel;
out vec3 vNormal; out vec3 vColor; out vec3 vPos; flat out float vTag;
void main() {
  vNormal = mat3(uView) * mat3(uModel) * aNormal; vColor = aColor; vTag = aTag; vPos = aPos;
  gl_Position = uMvp * uModel * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vColor; in vec3 vPos; flat in float vTag;
uniform int uMode; uniform vec4 uTint;
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
  if (uMode == 1) { // pick: encode tag as rgb
    float t = vTag;
    outColor = vec4(mod(t, 256.0), mod(floor(t / 256.0), 256.0), floor(t / 65536.0), 255.0) / 255.0;
    return;
  }
  if (uMode == 3) { outColor = vec4(vColor, 1.0); return; } // unlit lines
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.4))), 0.0) * 0.3;
  float rim = pow(1.0 - abs(n.z), 2.0);
  if (uMode == 2) { outColor = vec4(uTint.rgb * (0.5 + 0.5 * key) , uTint.a * (0.5 + rim)); return; }
  outColor = vec4(vColor * (0.22 + 0.75 * key + fill), 1.0);
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

export function createViewer(canvas, { onPick, theme: initialTheme = "dark", grid = true } = {}) {
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
  const u = Object.fromEntries(["uMvp", "uView", "uModel", "uMode", "uTint", "uClipN", "uClip"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const attribs = [
    ["aPos", 3],
    ["aNormal", 3],
    ["aColor", 3],
    ["aTag", 1],
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

  const solid = makeDrawable(["aPos", "aNormal", "aColor", "aTag"]);
  const ghost = makeDrawable(["aPos", "aNormal"]);
  const lines = makeDrawable(["aPos", "aColor"]);
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
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      const e = n * step;
      line([v, 0, -e], [v, 0, e], i === 0 ? [0.25, 0.4, 0.85] : minor); // along Z: blue at x=0
      line([-e, 0, v], [e, 0, v], i === 0 ? [0.85, 0.3, 0.3] : minor); // along X: red at z=0
    }
    line([0, 0, 0], [0, step * 2, 0], [0.35, 0.8, 0.35]); // +Y stub
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
    gl.bindVertexArray(solid.vao);
    if (!solid.count) return;
    if (!clipPlanes.length) {
      gl.drawElements(gl.TRIANGLES, solid.count, gl.UNSIGNED_INT, 0);
      return;
    }
    // With a cutaway, the insides of cut solids (back faces) act as section
    // faces. Where two cells share a wall, the cut cell's inside and its
    // neighbour's outside are coplanar: draw back faces in a second pass,
    // nudged toward the camera, so the cut cell wins instead of z-fighting.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.drawElements(gl.TRIANGLES, solid.count, gl.UNSIGNED_INT, 0);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.drawElements(gl.TRIANGLES, solid.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
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
    }
    gl.bindVertexArray(null);
  }

  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // ---- picking ---------------------------------------------------------------
  let fbo = null;
  let fboSize = [0, 0];
  let colorRb = null;
  let depthRb = null;
  function pick(clientX, clientY) {
    if (!solid.count) return 0;
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
    drawScene(1);
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
    if (moved < 4 && e.button === 0 && onPick) onPick(pick(e.clientX, e.clientY), e);
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
    /** Uploads a mesh. `colors` is rgb per vertex (defaults to a neutral blue). */
    setMesh(mesh, colors) {
      const n = mesh.positions.length / 3;
      if (!colors) {
        colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) colors.set([0.42, 0.71, 1.0], i * 3);
      }
      solid.upload(
        { aPos: mesh.positions, aNormal: mesh.normals, aColor: colors, aTag: Float32Array.from(mesh.tags) },
        mesh.indices,
      );
      redraw();
    },
    /** Translucent overlay drawn through everything; pass null to clear. */
    setGhost(mesh) {
      if (mesh) ghost.upload({ aPos: mesh.positions, aNormal: mesh.normals }, mesh.indices);
      else ghost.count = 0;
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
