// Guided part: a read-only view of one frozen lab (rearranged freeze <lab> <out>).
// Everything plays as MIDI through the design system's spessasynth with its shared
// General MIDI bank (vendor/design/sound/gm.sf3): each step's version of the part
// is a small looping MIDI file (loops.json), and the whole song in free play is a
// cover's MIDI, as in the lab page. Loudness between versions is baked into each loop's channel volume
// at freeze time. Every GET the lab page makes to the server is a file under
// ../data/ here. Nothing writes: no rating, no chord fixes, no new renders.

import { demoShell } from "../vendor/design/demoshell.js";
import { iconButton } from "../vendor/design/iconbutton.js";
import { seekable, outputDelay as delayOf } from "../vendor/design/playhead.js";

const DATA = "../data";
// the design system's shared General MIDI bank, the same sounds as the lab and every other tool
const SOUNDFONT = "../vendor/design/sound/gm.sf3";
const DEMO_LAB = "djopening";         // the lab try-dist is frozen from (only named in the hint below)
const RAMP = 0.03;                      // seconds of fade around a switch between versions

const $ = (id) => document.getElementById(id);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const getJSON = async (name) => {
  const r = await fetch(`${DATA}/${name}`);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
};

// ---- the habits a visitor can flip, in the order they are listed
const HABITS = {
  bass: { name: "Bass", levels: { song: "Song A's", donor: "Song B's" } },
  guitar: { name: "Guitar", levels: { picked: "Picked", strummed: "Strummed" } },
  drums: { name: "Drums", levels: { donor: "Song B's", song: "Song A's", none: "None" } },
  feel: { name: "Feel", levels: { straight: "Full speed", half: "Half-time" } },
  lead: { name: "Lead", levels: { true: "Song A's kept", false: "Out" } },
};
// what one flip changes, said once, in plain words
const CHANGED = {
  bass: { song: "Song A's own line comes back.", donor: "Song B's lines, walked onto Song A's roots." },
  guitar: { picked: "Song B's picking, each note moved onto Song A's chord tones.",
            strummed: "Song B's strum rhythm, struck as Song A's full chords." },
  drums: { donor: "Song B's drum groove.", song: "Song A's own drums.", none: "no drums: the guitars and bass stand alone." },
  feel: { straight: "full speed: Song B's bars laid over Song A's one for one.",
          half: "half-time: each Song B bar stretched over two of Song A's." },
  lead: { true: "Song A's lead guitar stays in.", false: "Song A's lead guitar drops out." },
};
// the rearranged version the switch lands on first (the approved cover): song B's bass,
// picking and drums on song A's chords, half-time
const FIRST = { bass: "donor", guitar: "picked", drums: "donor", feel: "half", lead: "false" };

let lab, loops, rolls = {}, rollRange = [48, 72];
let view = "original", settings = null;       // settings: the rearranged version's, factor -> level (strings)
let flipped = false;

// ---- audio: one context, made inside the first click
let ctx = null;

function audio() {
  if (!ctx) ctx = new AudioContext();
  ctx.resume();
  return ctx;
}
// the loop's length: song A's part (the rearranged versions match it), or song B's own part
const duration = () => (view === "songb" && loops?.donor ? loops.donor.length : lab.part_end - lab.part_start);

// ---- one synth for everything: spessasynth with the shared General MIDI bank, one
// sequencer, and a gain after it for the short fades. The part and the whole song take turns
// on it (one player at a time). A switch fades out, loads the next MIDI file and seeks it to
// the same moment, then fades back in: the MIDI files are a few KB and already fetched, so the
// load takes a render quantum or two.
const spessa = {
  synth: null, seq: null, out: null, ready: null, sf: null, loaded: "", mode: "", running: false, op: 0, from: 0,
  restarted: 0, struck: [], bins: new Map(),
  soundfont() {                                           // fetched as the page opens, used on the first click
    this.sf = this.sf || fetch(SOUNDFONT).then((r) => {
      if (!r.ok) throw new Error("the soundfont is missing");
      return r.arrayBuffer();
    });
    this.sf.catch(() => { this.sf = null; });
    return this.sf;
  },
  init() {
    this.ready = this.ready || (async () => {
      $("song-status").textContent = "loading sounds…";
      const lib = await import("../vendor/design/sound/spessasynth/spessasynth_lib.min.js");
      const sf = await this.soundfont();
      await ctx.audioWorklet.addModule("../vendor/design/sound/spessasynth/spessasynth_processor.min.js");
      const synth = new lib.WorkletSynthesizer(ctx);
      this.out = ctx.createGain();
      synth.connect(this.out);
      this.out.connect(ctx.destination);
      await synth.soundBankManager.addSoundBank(sf, "main");
      await synth.isReady;
      this.synth = synth;
      this.seq = new lib.Sequencer(synth, { skipToFirstNoteOn: false });
      this.seq.eventHandler.addEvent("songEnded", "ui", () => { if (this.mode === "song") song.ended(); });
      this.seq.eventHandler.addEvent("timeChange", "ui", (t) => {
        if (this.target != null && Math.abs(t - this.target) < 1e-3) this.target = null;
      });
      $("song-status").textContent = "";
    })();
    this.ready.catch(() => { this.ready = null; this.sf = null; });   // a failed load can be tried again
    return this.ready;
  },
  bin(name) {                                             // a MIDI file's bytes, fetched once
    if (!this.bins.has(name)) {
      this.bins.set(name, fetch(`${DATA}/files/${name}`).then((r) => {
        if (!r.ok) throw new Error(`${name}: ${r.status}`);
        return r.arrayBuffer();
      }));
      this.bins.get(name).catch(() => this.bins.delete(name));
    }
    return this.bins.get(name);
  },
  fade(to) {
    const g = this.out.gain, now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + RAMP);
  },
  // play `name` from `at` (seconds, or a function read at the moment it starts, after the
  // fade-out, so a switch lands where the loop is by then). false: something newer came first.
  // `held`: the file's pitched notes, [channel, pitch, velocity, start, end] (notes-*.json).
  // spessasynth's sequencer only plays note-ons it reaches: a seek replays programs and
  // controllers up to the new moment but clears its list of sounding notes, so a note that
  // began before the seek point would stay silent until the next attack. After seeking we
  // strike those notes ourselves; the sequencer's own note-off at each note's end releases them,
  // so only the remaining part sounds. Drums are left out: a restarted hit would be a new hit.
  // Notes struck by hand are remembered (`struck`) and released by hand before every seek and
  // on stop, so none can outlive a switch that lands before its own note-off. A loop wrap is a
  // seek inside the worklet with no hook on this side in time; spessasynth's sequencer runs
  // sendMIDIReset there (all notes off, stopAllChannels), which releases these voices too. The
  // set is kept until the next start or stop: a note-off at the wrap itself could cut a note
  // the new pass has just struck, while one sent behind a fade-out cuts nothing audible.
  async start(name, at, { loop, mode, held }) {
    const my = ++this.op;
    if (typeof at === "number") this.aim(at);            // report it through the fade-out too
    await this.init();
    const binary = await this.bin(name);
    const notes = await (held || []);
    if (my !== this.op) return false;
    if (this.running) {
      this.fade(0);
      await wait(RAMP * 1000);
      if (my !== this.op) return false;
    }
    this.release();
    if (this.loaded !== name) {
      this.seq.loadNewSongList([{ binary: binary.slice(0), fileName: name }]);
      this.loaded = name;
    }
    this.seq.loopCount = loop ? Infinity : 0;
    const from = typeof at === "function" ? at() : at;
    this.aim(from);
    this.seq.currentTime = from;
    this.seq.play();
    this.restarted = 0;
    for (const [c, p, v, s, e] of notes) {         // messages keep their order: this lands after the seek
      if (s < from - 0.005 && e - from > 0.05) {
        this.synth.noteOn(c, p, v); this.struck.push([c, p]); this.restarted++;
      }
    }
    this.mode = mode; this.running = true;
    this.fade(1);
    return true;
  },
  async stop() {
    const my = ++this.op;
    if (!this.running) return;
    this.running = false;
    this.fade(0);
    await wait(RAMP * 1000 + 10);
    if (my === this.op) { this.release(); this.seq.pause(); }
  },
  release() {                                     // note-off for every note struck by hand
    for (const [c, p] of this.struck) this.synth.noteOff(c, p);
    this.struck = [];
  },
  // spessasynth's Sequencer moves its time on the audio thread: after `currentTime = t` (and
  // play(), which counts from 0 until then) its getter gives the old time until the audio thread
  // answers with a "timeChange", a frame or so later. Until then `time` is the target, so the
  // song's head never shows the old place (or 0) after a jump.
  target: null, targetUntil: 0,
  // `from` also keeps the last jump's place for the heard head (song.follow), from the moment it
  // is announced, through the fade-out
  aim(t) { this.target = t; this.from = t; this.targetUntil = performance.now() + 1000; },
  get time() {
    if (this.target != null && performance.now() < this.targetUntil) return this.target;
    return this.seq && this.loaded ? this.seq.currentTime : 0;
  },
};

// ---- the part: one looping MIDI file per version, on the page's own clock
let playing = false, t0 = 0, offset0 = 0, gen = 0;

function variantOf(s) {
  return lab.variants.find((v) => Object.keys(lab.factors).every((f) => String(v.settings[f]) === s[f]));
}
// what plays now: its loop file (loudness already set in its channel volume) and its roll
function source() {
  if (view === "songb") return { key: "donor", file: loops.donor.file, roll: "donor" };
  const key = view === "original" ? "original" : String(variantOf(settings).id);
  return { key, file: loops[key].file, roll: view === "original" ? "original" : Number(key) };
}

// a loop's pitched notes by channel, fetched once: what to restart after a seek
const heldNotes = new Map();
function notesOf(key) {
  if (!heldNotes.has(key)) {
    heldNotes.set(key, getJSON(loops[key].notes).catch(() => { heldNotes.delete(key); return []; }));
  }
  return heldNotes.get(key);
}
const startPart = (at) => {
  const src = source();
  return spessa.start(src.file, at, { loop: true, mode: "part", held: notesOf(src.key) });
};

function position(at) {
  if (!playing) return offset0;
  const d = duration(), p = offset0 + ((at ?? ctx.currentTime) - t0);
  return ((p % d) + d) % d;
}
// the output's own delay: Bluetooth headphones add 200 ms or more, so sound reaches the ear that
// much after the synth makes it. The playhead and the lit notes show what is heard.
const outputDelay = () => delayOf(ctx);
// where the listener is: the clock less the output's delay, held at the last start or seek
// until its sound arrives (so a jump never draws behind where it went)
const heard = () => (playing ? position(Math.max(t0, ctx.currentTime - outputDelay())) : position());

async function play() {
  const my = ++gen;
  song.idle();                          // one player at a time
  let ok;
  try {
    ok = await startPart(() => offset0);
  } catch (err) {
    status(`no playback: ${err.message}`); partPlay.setPressed(false); return;
  }
  if (!ok || my !== gen) return;
  t0 = ctx.currentTime; playing = true;
  partPlay.setPressed(true);
  tick(); checkRail(); prefetch();
}

function partIdle() {                   // stop the part's clock and controls, keep its place
  gen++;
  if (playing) offset0 = position();
  playing = false;
  partPlay.setPressed(false);
  drawRoll();
}

function pause() {
  partIdle();
  spessa.stop();                        // also drops a start still loading
}

// switch what plays at the same moment in the loop, or, after a view change (fromTop), from
// the loop's very start: seeked to exactly 0 and the clock started when the sound does, so the
// first beat is not lost to the fade-out
let fromTop = false;
async function retarget() {
  drawRoll();
  const top = fromTop;
  fromTop = false;
  if (!playing) { checkRail(); return; }
  const my = ++gen;
  let ok;
  try {
    ok = await startPart(top ? 0 : () => position());
  } catch (err) { status(err.message); return; }
  if (!ok || my !== gen) return;
  if (top) { offset0 = 0; t0 = ctx.currentTime; }
  checkRail(); prefetch();
}

// fetch what is one flip away, so the next switch has its file at hand
function prefetch() {
  if (!settings) return;
  const next = ["original", ...(loops.donor ? ["donor"] : [])];
  for (const [f, levels] of Object.entries(lab.factors)) {
    for (const l of levels) {
      const v = variantOf({ ...settings, [f]: String(l) });
      if (v) next.push(String(v.id));
    }
  }
  next.forEach((k) => { spessa.bin(loops[k].file).catch(() => {}); notesOf(k); });
}

function tick() {
  if (!playing) return;
  showHead();
  requestAnimationFrame(tick);
}

let dragAt = null;                      // where a drag holds the playhead, while it lasts

function showHead() {
  const p = dragAt ?? heard();
  $("head").style.left = `${(p / duration()) * 100}%`;
  $("time").textContent = `${fmt(p)} / ${fmt(duration())}`;
  drawRoll();
}

// a click, tap or drag on the roll (the playhead line included) moves the playhead there.
// Paused, it just moves and Play starts from it. Playing, the head follows the pointer and the
// sound moves once, on release: a seek on every move would restart the notes over and over.
function seekPart(p) {
  if (!lab) return;
  offset0 = Math.max(0, Math.min(p, duration() - 1e-3));
  if (playing) { t0 = ctx.currentTime; retarget(); }
  showHead();
}
seekable($("strip"), {                  // the design system's playhead (playhead.js)
  duration: () => duration(),
  enabled: () => !!lab,
  onScrub: (p) => {
    dragAt = p;
    if (!playing) offset0 = Math.min(p, duration() - 1e-3);
    showHead();
  },
  onSeek: (p) => { dragAt = null; seekPart(p); },
  onCancel: () => { dragAt = null; showHead(); },
});

function status(text) { $("changed").textContent = text; }

// ---- piano roll of what plays (design/roll.md), as in the lab page
let palette = null;
function colorOf(token) {           // tokens are light-dark() pairs a canvas can't read: resolve them
  const el = document.createElement("span");
  el.style.color = `var(${token})`; document.body.appendChild(el);
  const m = getComputedStyle(el).color.match(/[\d.]+/g).slice(0, 3).map(Number); el.remove();
  return m;
}
const rgb = (c) => `rgb(${c.map(Math.round).join(",")})`;
const mix = (a, b, p) => rgb(a.map((x, i) => x * p + b[i] * (1 - p)));
const pitchShare = (p, lo, hi) => (hi > lo ? Math.max(0, Math.min(1, (p - lo) / (hi - lo))) : 1);
const readPalette = () => ({ acc: colorOf("--acc"), ground: colorOf("--ground"), band: colorOf("--band"),
                             mut: colorOf("--ink-mut"), ink: colorOf("--ink") });

function drawRoll() {
  const cv = $("roll");
  if (!lab) return;
  const r = rolls[source().roll];
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight, top = 20;
  if (!w) return;
  palette = palette || readPalette();
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const { acc, ground, band, mut, ink } = palette, [lo, hi] = rollRange;
  const rh = (h - top - 4) / (hi - lo + 1), xs = w / duration(), y = (p) => h - 2 - (p - lo + 1) * rh;
  const now = dragAt ?? heard();
  g.clearRect(0, 0, w, h);
  g.fillStyle = mix(band, ground, 0.45);
  for (let p = lo; p <= hi; p++) if ([1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12)) g.fillRect(0, y(p), w, rh);
  if (!r) return;
  for (const n of r.notes) {
    const on = playing && !n.kept && now >= n.s && now < n.e;
    const x = n.s * xs, nw = Math.max(1, (n.e - n.s) * xs - 1), ny = y(n.p), nh = Math.max(1, rh - 1);
    // roll.md: shaded by pitch, 40 to 100 percent accent from the lowest to the highest note
    g.fillStyle = n.kept ? mix(mut, ground, 0.3) : on ? rgb(acc) : mix(acc, ground, 0.4 + 0.6 * pitchShare(n.p, lo + 1, hi - 1));
    g.fillRect(x, ny, nw, nh);
    if (on && nh > 2) { g.strokeStyle = rgb(ink); g.lineWidth = 1; g.strokeRect(x + 0.5, ny + 0.5, nw - 1, nh - 1); }
  }
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { palette = null; drawRoll(); drawChords(); });
addEventListener("resize", () => { drawRoll(); drawChords(); drawSections(); });

// song A's chords along the top of the roll: they stay the same whatever plays
function drawChords() {
  if (!lab) return;
  const box = $("chords"), w = box.clientWidth;
  box.innerHTML = "";
  const runs = [];                     // half-bar chords, merged while the chord stays the same
  for (const s of lab.segments) {
    const a = Math.max(s.start, lab.part_start) - lab.part_start, b = Math.min(s.end, lab.part_end) - lab.part_start;
    if (b <= a) continue;
    const last = runs[runs.length - 1];
    if (last && last.chord === s.chord) last.b = b; else runs.push({ chord: s.chord, a, b });
  }
  for (const { chord, a, b } of runs) {
    const el = document.createElement("div");
    el.className = "chord" + ((b - a) / duration() * w < 22 ? " tiny" : "");
    el.style.left = `${(a / duration()) * 100}%`; el.style.width = `${((b - a) / duration()) * 100}%`;
    el.textContent = chord || "·";
    box.appendChild(el);
  }
}

// ---- controls
function drawViews() {
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $("habits").classList.toggle("off", view !== "rearranged");
  $("habits").querySelectorAll("button").forEach((b) => { b.disabled = view !== "rearranged"; });
  $("chords").hidden = view === "songb";            // the chords are Song A's
}

function drawHabits() {
  const rows = Object.keys(HABITS).filter((f) => lab.factors[f] && lab.factors[f].length > 1);
  $("habits").innerHTML = rows.map((f) => `<span class="label" id="h-${f}">${HABITS[f].name}</span>
    <span class="ds-choice" role="group" aria-labelledby="h-${f}">${lab.factors[f].map((l) => `<button type="button"
      data-f="${f}" data-l="${String(l)}" aria-pressed="${settings[f] === String(l)}">${HABITS[f].levels[String(l)] ?? String(l)}</button>`).join("")}</span>`).join("");
  $("habits").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => flip(b.dataset.f, b.dataset.l)));
  drawViews();
}

// where a named part sits, in small print: "bars 9-16"; nothing when the name already says it
function barsOf(p) {
  if (!p?.bars) return "";
  const [a, b] = p.bars, text = a === b ? `bar ${a}` : `bars ${a}-${b}`;
  return p.name.trim().toLowerCase() === text ? "" : text;
}

// the pane's header names what loops: song A's part (which the versions share) or song B's
function partHeader() {
  const where = barsOf(song.parts.find((p) => p.name === lab.part));
  const name = view === "songb" ? `Song B · ${loops.donor.part}` : [lab.part, where].filter(Boolean).join(" · ");
  $("part-name").textContent = `${name} · ${fmt(duration())} loop`;
  $("time").textContent = `${fmt(position())} / ${fmt(duration())}`;
}

function setView(v) {
  if (v === view) return;
  view = v;
  // each view (song A, song B, rearranged) starts from the top of its loop; a habit flip keeps
  // the place (flip), since it changes the same version's playing
  offset0 = 0;
  if (playing) t0 = ctx.currentTime;
  fromTop = true;
  drawViews(); drawChords(); partHeader();
  status(v === "original" ? "Song A as written."
    : v === "songb" ? `Song B as written: ${loops.donor.part}, the band Song A borrows from.`
    : "Song B's bass, picking and drums on Song A's chords, at half-time.");
  retarget();
}

function flip(f, l) {
  if (view !== "rearranged" || settings[f] === l) return;
  settings = { ...settings, [f]: l };
  if (rail.current === "habit") flipped = true;
  drawHabits();
  $("changed").innerHTML = `<b>${HABITS[f].name}:</b> ${CHANGED[f]?.[l] ?? l}`;
  retarget();
}

// ---- the rail ticks only on what was heard: each step counts once its version is playing
function checkRail() {
  if (!playing) return;
  if (view === "original") rail.done("part");
  else if (view === "songb") rail.done("songb");
  else if (view === "rearranged") {
    rail.done("switch");
    if (flipped) rail.done("habit");
  }
}

const shell = demoShell($("demo"), {
  product: "Rearranged",
  title: "listen to a song in the style of another.",
  intro: "Song A covered in the style of Song B. Everything here was arranged ahead of time and plays from MIDI.",
  steps: [
    { id: "part", label: "press play" },
    { id: "songb", label: "switch to Song B" },
    { id: "switch", label: "switch to Rearranged" },
    { id: "habit", label: "flip one habit at a time" },
  ],
  // The rail's title stays a plain "Try it out!"; the way to the full studio
  // comes at the end of the tour, as in the YSAD demo.
  endText: "That was the first step. ",
  // Space pauses the whole song if it is playing; otherwise it drives the part loop
  // (start it, or pause it if already playing). Only one thing can be primary, and
  // once the song is playing that is the louder, more surprising thing to have Space
  // silently leave running, so it takes priority; before that, Space is the part loop.
  // No label, so no "Space: play" hint under the rail; Space still plays.
  primary: { toggle: () => (songPlay.pressed ? songPlay.toggle() : partPlay.toggle()) },
  onDone: () => { $("song-pane").hidden = false; song.show(); },
  onReset: () => {
    if (!lab) return;
    song.pause(); pause();
    offset0 = 0; flipped = false; song.at = song.origin();
    view = "original"; settings = firstSettings();
    drawHabits(); drawRoll();
    $("head").style.left = "0%"; $("time").textContent = `${fmt(0)} / ${fmt(duration())}`;
    status("");
    $("song-pane").hidden = true;
  },
});
const rail = shell.rail;
// After the tour: the way to the full studio, in a new tab so the demo stays
// where it is, with the same words as the showcase's button.
{
  const full = document.createElement("a");
  full.className = "full-link";
  full.href = "../";
  full.target = "_blank";
  full.rel = "noopener";
  full.textContent = "Full version ↗";
  document.querySelector(".steprail-end")?.append(full);
}

function firstSettings() {
  const s = {};
  for (const [f, levels] of Object.entries(lab.factors)) {
    s[f] = levels.map(String).includes(FIRST[f]) ? FIRST[f] : String(levels[0]);
  }
  return variantOf(s) ? s : Object.fromEntries(Object.entries(lab.variants[0].settings).map(([k, v]) => [k, String(v)]));
}

const partPlay = iconButton($("play"), { key: "Space", onPress: (pressed) => { audio(); pressed ? play() : pause(); } });
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

// ---- whole song (free play): a cover's MIDI on the same synth, as the lab page plays it
const song = {
  parts: [], covers: [], at: 0, started: false,
  get paused() { return !(spessa.running && spessa.mode === "song"); },
  get time() { return this.paused ? this.at : spessa.time; },
  // the song runs from its first part to its last: the renders hold nothing before the first
  // part (song A's MIDI opens on a lead-in bar and a pickup), so the timeline starts there
  origin() { return this.parts.length ? this.parts[0].start : 0; },
  length() { return this.parts.length ? this.parts[this.parts.length - 1].end : 0; },
  async play(at) {
    audio();
    if (playing) partIdle();              // the synth moves straight over from the part
    const pick = this.covers.find((c) => c.midi === this.pick) || this.covers[0];
    if (!pick) return;
    const from = at ?? this.time;         // a new render picks up where the last one was
    let ok;
    try {
      ok = await spessa.start(pick.midi, from, { loop: false, mode: "song" });
    } catch (err) { $("song-status").textContent = `no playback: ${err.message}`; return; }
    if (!ok) return;
    this.started = true;
    songPlay.setPressed(true);
    this.follow();
  },
  pause() {
    if (!this.paused) { this.at = spessa.time; spessa.stop(); }
    songPlay.setPressed(false);
  },
  idle() {                                // the part takes the synth: keep the place, show Play
    if (!this.paused) this.at = spessa.time;
    songPlay.setPressed(false);
  },
  ended() { this.at = this.origin(); spessa.running = false; songPlay.setPressed(false); },
  follow() {
    // playing, the head shows what is heard: the clock less the output's delay, never behind
    // where the last start or seek went
    const t = this.paused ? this.time : Math.max(spessa.from, this.time - outputDelay());
    const o = this.origin(), total = this.length() - o, at = Math.max(0, Math.min(t, this.length()) - o);
    $("song-time").textContent = this.started ? `${fmt(at)} / ${fmt(total)}` : "";
    if (total > 0) $("sec-head").style.left = `${(at / total) * 100}%`;
    $("sections").querySelectorAll(".sec").forEach((e) => {
      const p = this.parts[+e.dataset.i];
      e.classList.toggle("current", at + o >= p.start && at + o < p.end);
    });
    if (!this.paused) requestAnimationFrame(() => this.follow());
  },
  show() { drawSections(); drawCovers(); },
};

// one line per render; the lead is named only when the renders differ in it
const leadOf = (s) => s.lead ? "Lead: kept" : s.lead_in && s.lead_in.length ? `Lead: only in the ${s.lead_in.join(", ")}` : "Lead: out";
// one "Name: Value" per habit, both in sentence case, as on the switches
function describe(s) {
  const feelIn = Object.entries(s.feel_in || {}).map(([p, f]) => `${p} ${f === "half" ? "half-time" : "full speed"}`);
  const out = [`Bass: ${HABITS.bass.levels[s.bass] ?? s.bass}`, `Guitar: ${HABITS.guitar.levels[s.guitar] ?? s.guitar}`,
               `Drums: ${HABITS.drums.levels[s.drums] ?? s.drums}`,
               `Feel: ${HABITS.feel.levels[s.feel] ?? s.feel}${feelIn.length ? ` (${feelIn.join(", ")})` : ""}`];
  if (!song.covers.every((c) => leadOf(c.settings) === leadOf(s))) out.push(leadOf(s));
  return out.join(" · ");
}

function drawCovers() {
  const box = $("covers");
  if (!song.covers.length) { box.innerHTML = `<p class="mut small">No covers of the whole song were saved with this demo.</p>`; return; }
  song.pick = song.pick || song.covers[0].midi;
  box.innerHTML = song.covers.map((c) => `<button type="button" class="ds-button" data-m="${c.midi}" aria-pressed="${c.midi === song.pick}">${describe(c.settings)}</button>`).join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    song.pick = b.dataset.m; drawCovers(); song.play();
  }));
  $("song-play").disabled = false;
}

function drawSections() {
  const box = $("sections"), o = song.origin(), total = song.length() - o;
  box.querySelectorAll(".sec").forEach((e) => e.remove());
  if (total <= 0) return;
  song.parts.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "sec" + (((p.end - p.start) / total) * box.clientWidth < 40 ? " narrow" : "");
    el.style.left = `${((p.start - o) / total) * 100}%`; el.style.width = `${((p.end - p.start) / total) * 100}%`;
    const name = document.createElement("b"), where = barsOf(p);
    name.textContent = p.name;
    el.append(name);
    if (where) {                         // the bars in small print under the name
      const small = document.createElement("small");
      small.textContent = where;
      el.append(small);
    }
    el.title = `${p.name}${where ? ` (${where})` : ""}: play from here`; el.dataset.i = i;
    el.addEventListener("click", () => song.play(p.start));
    box.appendChild(el);
  });
}

const songPlay = iconButton($("song-play"), { key: "Space", onPress: (pressed) => { audio(); pressed ? song.play() : song.pause(); } });

// ---- start: the frozen lab, or a plain line saying how to build it
async function start() {
  let frozen;
  try {
    frozen = await getJSON("lab.json");
  } catch (err) {
    $("missing").hidden = false;
    $("missing").textContent = `demo data not built: run rearranged freeze ${DEMO_LAB} try-dist`;
    $("part-pane").hidden = true;
    return;
  }
  // the parts come early: the header names the part's bars
  [loops, song.parts] = await Promise.all([getJSON("loops.json"), getJSON("parts.json").catch(() => [])]);
  // only now: a resize (the showcase sizing its frame) redraws as soon as `lab` is set
  lab = frozen;
  song.at = song.origin();
  getJSON("credit.json").then((c) => {
    $("Song A").textContent = c.a || "";
    $("Song B").textContent = c.b || "";
    $("Song B-row").hidden = !c.b;
    $("songs").hidden = !(c.a || c.b);
  }).catch(() => {});
  document.querySelector('[data-view="songb"]').hidden = !loops.donor;
  settings = firstSettings();
  partHeader();
  $("time").textContent = `${fmt(0)} / ${fmt(duration())}`;
  drawHabits(); drawChords();
  // fetch the sounds and the two versions the first steps play; the synth waits for the first click
  spessa.soundfont().catch(() => {});
  spessa.bin(loops.original.file).catch(() => {});
  spessa.bin(loops[String(variantOf(settings).id)].file).catch(() => {});
  const ids = ["original", ...(loops.donor ? ["donor"] : []), ...lab.variants.map((v) => v.id)];
  const got = await Promise.all(ids.map((id) => getJSON(`roll-${id}.json`).catch(() => null)));
  ids.forEach((id, i) => { if (got[i]) rolls[id] = got[i]; });
  const ps = got.filter(Boolean).flatMap((r) => r.notes.map((n) => n.p));
  if (ps.length) rollRange = [Math.min(...ps) - 1, Math.max(...ps) + 1];
  $("strip-msg").hidden = true;
  $("play").disabled = false;
  drawRoll();
  const covers = await getJSON("covers.json").catch(() => []);
  // the render that matches the first rearranged loop leads the list, the one-habit changes follow
  const same = (c) => Object.entries(firstSettings()).every(([k, v]) => String(c.settings[k]) === v);
  song.covers = [...covers.filter(same), ...covers.filter((c) => !same(c))];
}

// a small read-only handle for checks (the walk script reads it; nothing here depends on it)
window.rearrangedTry = {
  get audioState() { return ctx ? ctx.state : "none"; },
  get playing() { return playing; },
  get view() { return view; },
  get settings() { return { ...settings }; },
  get songPlaying() { return !song.paused; },
  get loaded() { return spessa.loaded; },                  // the MIDI file in the sequencer
  get sequencerTime() { return spessa.seq ? spessa.seq.currentTime : null; },
  get partTime() { return playing ? position() : null; },
  get partAt() { return lab ? position() : null; },               // the playhead, playing or paused
  get partLength() { return lab ? duration() : null; },
  get restarted() { return spessa.restarted; },          // notes struck again after the last seek
  get voices() {                                            // voices sounding now, as the worklet last said
    return spessa.synth ? spessa.synth.midiChannels.reduce((n, c) => n + (c.voiceCount || 0), 0) : 0;
  },
  monitor() { return ctx && spessa.out ? { ctx, out: spessa.out } : null; },   // to listen in on the synth
  // the synth's own events ("noteOn", "programChange"), for a check to log what really plays
  on(event, fn) { spessa.synth?.eventHandler.addEvent(event, `check-${event}`, fn); return !!spessa.synth; },
};

start();
