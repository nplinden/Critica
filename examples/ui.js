// Small DOM helpers shared by the workspaces.

/** Tiny DOM builder: h("div", { class: "x", onclick }, ...children). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) {
      try {
        el[k] = v;
      } catch {
        // Read-only reflected properties (e.g. input.list) must be set as attributes.
        el.setAttribute(k, v);
      }
    } else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

/**
 * Re-renders a form without losing the user's place: the focused field (by
 * data-path) gets focus and its cursor/selection back after the rebuild.
 */
export function keepFocus(container, render) {
  const active = document.activeElement;
  const path = active && container.contains(active) ? active.dataset?.path : null;
  let range = null;
  try {
    if (path && active.selectionStart != null) range = [active.selectionStart, active.selectionEnd];
  } catch {
    // Number inputs have no selection API.
  }
  render();
  if (!path) return;
  const el = container.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (!el || el.disabled) return;
  el.focus({ preventScroll: true });
  if (range) {
    try {
      el.setSelectionRange(...range);
    } catch {
      // Not a text field.
    }
  }
}
