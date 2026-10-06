// A small "Get in touch" form, collapsed until opened, posting to Formspree with fetch (no
// iframe, no redirect). The endpoint is this one value.
export const CONTACT_ENDPOINT = "https://formspree.io/f/mrpbjkak";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function contactForm(box, { endpoint = CONTACT_ENDPOINT } = {}) {
  box.innerHTML = `<details class="contact"><summary>Get in touch</summary>
    <form class="contact-form" novalidate>
      <p>Say hi, ask anything, or show me what you made.</p>
      <label><span>Name</span><input name="name" class="ds-field" autocomplete="name"></label>
      <label><span>Email</span><input name="email" class="ds-field" type="email" required autocomplete="email"></label>
      <label><span>Message</span><textarea name="message" class="ds-field" rows="3"></textarea></label>
      <input type="hidden" name="_subject" value="Rearranged: new message">
      <input type="text" name="_gotcha" class="gotcha" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="row"><button type="submit" class="ds-button primary">Send</button><span class="contact-msg mut" aria-live="polite"></span></div>
    </form></details>`;
  const form = box.querySelector("form");
  const msg = box.querySelector(".contact-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.elements.email;
    if (!email.value.trim() || !email.checkValidity()) {
      msg.textContent = "Please add an email I can write back to.";
      email.focus();
      return;
    }
    const send = form.querySelector("button[type=submit]");
    send.disabled = true;
    msg.textContent = "Sending…";
    try {
      const r = await fetch(endpoint, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`${r.status}`);
      form.outerHTML = `<p class="contact-thanks">${esc("Thank you, I'll write back soon.")}</p>`;
    } catch (err) {
      send.disabled = false;
      msg.textContent = "Sorry, that didn't go through. Please try again in a moment.";
    }
  });
  return form;
}
