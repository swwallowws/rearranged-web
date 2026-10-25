// Rearranged runs in the browser: the engine as WebAssembly, projects kept in this browser. Every
// page puts the colour mode in its header and a footer saying where the work happens, beside the
// small contact form; then asks for its backend.
import { browserBackend } from "./browser.js";
import { contactForm } from "../vendor/design/contact.js";
import { themeSwitch } from "../vendor/design/themeswitch.js";

const NOTE = "Runs in your browser. Your MIDI files stay on this machine; nothing is uploaded.";

/** Draws the colour mode and the footer; resolves to the backend. */
export async function setupRuns() {
  const header = document.querySelector("header.ds-header");
  themeSwitch(header.querySelector(".modes"), { onChange: () => dispatchEvent(new Event("themechange")) });
  const bar = document.createElement("footer");
  bar.className = "runs-bar ds-footer";
  bar.innerHTML = `<span class="runs-note"></span><span class="contact-slot"></span>`;
  bar.querySelector(".runs-note").textContent = NOTE;
  document.body.append(bar);
  contactForm(bar.querySelector(".contact-slot"), { subject: "Rearranged: new message" });
  return browserBackend();
}

/** A project's page address. */
export const labHref = (id) => `lab.html?id=${encodeURIComponent(id)}`;
