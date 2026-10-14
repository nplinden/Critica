// Minimal XML reader/writer, sufficient for OpenMC input files. Runs in the
// browser and in Node (no DOMParser needed).
//
// Element: { name, attrs: { [k]: string }, children: Element[], text: string }

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** Parses a document; returns the list of top-level elements. */
export function parseXML(src) {
  let i = 0;
  const roots = [];
  const stack = [];
  const fail = (msg) => {
    const line = src.slice(0, i).split("\n").length;
    throw new Error(`XML parse error at line ${line}: ${msg}`);
  };
  const appendText = (t) => {
    if (stack.length) stack[stack.length - 1].text += t;
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      appendText(decode(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decode(src.slice(i, lt)));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end < 0) fail("unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end < 0) fail("unterminated CDATA");
      appendText(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      if (end < 0) fail("unterminated declaration");
      i = end + 1;
    } else if (src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      if (end < 0) fail("unterminated closing tag");
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`unexpected </${name}>`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(src.slice(i, i + 200));
      if (!m) fail("invalid tag");
      const el = { name: m[1], attrs: {}, children: [], text: "" };
      i += m[0].length;
      const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
      for (;;) {
        attrRe.lastIndex = i;
        const a = attrRe.exec(src);
        if (!a) break;
        el.attrs[a[1]] = decode(a[3] ?? a[4]);
        i = attrRe.lastIndex;
      }
      while (/\s/.test(src[i])) i++;
      let selfClosing = false;
      if (src.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
      } else if (src[i] === ">") {
        i += 1;
      } else {
        fail(`malformed tag <${el.name}>`);
      }
      (stack.length ? stack[stack.length - 1].children : roots).push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1].name}>`);
  return roots;
}

/** Value of an attribute or of a same-named child element's text (OpenMC allows both). */
export function getText(el, name, fallback = undefined) {
  if (name in el.attrs) return el.attrs[name].trim();
  const child = el.children.find((c) => c.name === name);
  return child ? child.text.trim() : fallback;
}

export function getList(el, name, convert = Number) {
  const text = getText(el, name);
  if (text === undefined || text === "") return undefined;
  return text.split(/\s+/).map(convert);
}

export const children = (el, name) => el.children.filter((c) => c.name === name);

const escape = (s) =>
  String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/** Builds an element. Attributes with undefined/null values are omitted. */
export function element(name, attrs = {}, children = [], text = "") {
  const clean = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) clean[k] = String(v);
  return { name, attrs: clean, children, text };
}

/** Serializes an element tree with two-space indentation. */
export function serializeXML(el, indent = "") {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${escape(v)}"`)
    .join("");
  const text = el.text.trim();
  if (!el.children.length && !text) return `${indent}<${el.name}${attrs}/>\n`;
  if (!el.children.length) return `${indent}<${el.name}${attrs}>${escape(text)}</${el.name}>\n`;
  const inner = el.children.map((c) => serializeXML(c, indent + "  ")).join("");
  const textLine = text ? `${indent}  ${escape(text)}\n` : "";
  return `${indent}<${el.name}${attrs}>\n${textLine}${inner}${indent}</${el.name}>\n`;
}

export const xmlDocument = (root) => `<?xml version='1.0' encoding='utf-8'?>\n${serializeXML(root)}`;
