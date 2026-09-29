// Where Rearranged runs: "In your browser" (the default: the engine as WebAssembly, labs kept
// in this browser) or "This computer" (the local server, rearranged-web, shown only when it
// answers). Every page puts the switch in its header, a line under it saying where the work
// happens, and the small contact form; then asks for its backend.
import { browserBackend } from "./browser.js";
import { contactForm } from "./contact.js";
import { serverBackend } from "./server.js";

export const SERVER_PORT = 8010;                 // rearranged-web's default --port
const KEY = "rearranged.runs";
const NOTES = {
  browser: "Runs in your browser. Your MIDI files stay on this machine; nothing is uploaded.",
  computer: "Runs on this computer, through the local Rearranged server.",
};

const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const remember = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: not kept */ } };

async function answers(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    return (await r.json()).app === "rearranged";
  } catch {
    return false;
  }
}

/** The local server's address if it answers: this page's own origin when the server served
 * it, else http://localhost:<port>. */
export async function findServer() {
  const here = location.pathname.replace(/[^/]*$/, "").replace(/\/$/, "");
  if (location.protocol.startsWith("http") && (await answers(`${location.origin}${here}`))) return `${location.origin}${here}`;
  for (const host of ["127.0.0.1", "localhost"]) {
    const base = `http://${host}:${SERVER_PORT}`;
    if (base !== location.origin && (await answers(base))) return base;
  }
  return null;
}

/** Draws the switch and the note; resolves to the backend in use. `fixed` ("browser" or
 * "computer") pins a lab's own place: switching then goes to the labs of the other place. */
export async function setupRuns({ fixed } = {}) {
  const header = document.querySelector("header.bar");
  const slot = document.createElement("span");
  slot.className = "runs";
  slot.innerHTML = `<span class="mut">Runs:</span><span class="choice" role="group" aria-label="Where Rearranged runs">
    <button type="button" data-runs="browser">In your browser</button><button type="button" data-runs="computer" hidden>This computer</button></span>`;
  header.appendChild(slot);
  const bar = document.createElement("div");
  bar.className = "runs-bar";
  bar.innerHTML = `<span class="runs-note"></span><span class="spacer"></span><span class="contact-slot"></span>`;
  header.after(bar);
  contactForm(bar.querySelector(".contact-slot"));

  const server = await findServer();
  let where = fixed || remembered() || "browser";
  if (where === "computer" && !server) where = "browser";
  slot.querySelector('[data-runs="computer"]').hidden = !server;
  const draw = () => {
    slot.querySelectorAll("[data-runs]").forEach((b) => b.classList.toggle("on", b.dataset.runs === where));
    bar.querySelector(".runs-note").textContent = NOTES[where];
  };
  draw();
  slot.querySelectorAll("[data-runs]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.runs === where) return;
    remember(b.dataset.runs);
    if (fixed) location.href = "index.html";
    else location.reload();
  }));
  document.documentElement.dataset.runs = where;
  return where === "computer" ? serverBackend(server) : browserBackend();
}

/** A lab's page address: its id and where it lives. */
export const labHref = (id, where) => `lab.html?id=${encodeURIComponent(id)}&on=${where}`;
