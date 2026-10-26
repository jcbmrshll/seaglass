// building DOM without a framework, shared by the frontend's modules

// an element (SVG for SVG tags) with attributes, "on*" listeners and children;
// "text" sets its text, so labels from a run never go in as markup
const SVG_TAGS = new Set(["svg", "path", "line", "polyline", "polygon", "circle", "ellipse", "text", "g", "rect", "title"]);

export function h(tag, attrs = {}, ...children) {
  const svg = SVG_TAGS.has(tag);
  const el = svg
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
