// What a metric or media key is (SPEC.md §3.3), shown beside it by a button that opens
// it in the page's #note, made here if the page has none: one open at a time, as {id,
// anchor}. Cards are redrawn as a run logs, so a button drawn again with the same id
// takes the open one over.

import { h } from "./dom.js";

let openNote = null;
let listening = false;

function noteEl() {
  return document.getElementById("note") ?? document.body.appendChild(h("div", { id: "note", hidden: true }));
}

// a click elsewhere or Escape closes it, and it follows its button as anything
// scrolls; listened for from the first button on
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("click", (e) => openNote && !e.target.closest?.("#note") && closeNote());
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeNote());
  document.addEventListener("scroll", placeNote, { capture: true, passive: true });
  addEventListener("resize", placeNote);
}

// a button that opens notes ([{names, text}], or one text) beside it; null if there are
// none
export function noteButton(id, notes) {
  if (typeof notes === "string") notes = [{ names: [], text: notes }];
  if (!notes?.length) return null;
  listen();
  const open = openNote?.id === id;
  const btn = h("button", {
    class: `info${open ? " on" : ""}`, text: "i", title: "what this is", "aria-label": "what this is",
    "aria-controls": "note", "aria-expanded": String(open),
    onclick: (e) => {
      e.stopPropagation();
      if (openNote?.id === id) closeNote();
      else showNote(id, btn, notes);
    },
  });
  if (open) openNote.anchor = btn;
  return btn;
}

function showNote(id, anchor, notes) {
  closeNote();
  const el = noteEl();
  el.replaceChildren(...notes.map((n) => h("p", {}, n.names.length > 0 && h("b", { text: n.names.join(", ") }), n.text)));
  el.hidden = false;
  openNote = { id, anchor };
  anchor.classList.add("on");
  anchor.setAttribute("aria-expanded", "true");
  placeNote();
}

export function closeNote() {
  if (!openNote) return;
  openNote.anchor.classList.remove("on");
  openNote.anchor.setAttribute("aria-expanded", "false");
  openNote = null;
  noteEl().hidden = true;
}

// under its button, or over it where there's no room below, and inside the window
function placeNote() {
  if (!openNote) return;
  if (!openNote.anchor.isConnected) return closeNote();
  const el = noteEl();
  const a = openNote.anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const below = a.bottom + 6 + r.height <= innerHeight - 4;
  el.style.left = `${Math.max(4, Math.min(innerWidth - r.width - 4, a.left - 8))}px`;
  el.style.top = `${below ? a.bottom + 6 : Math.max(4, a.top - 6 - r.height)}px`;
}
