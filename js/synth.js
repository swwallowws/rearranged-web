// One synth for the page: the vendored spessasynth with the lab's soundfont and one sequencer,
// a gain after it for short fades and each version's level. The part (in the browser, one
// looping MIDI file per version) and the whole song take turns on it, as on the /try/ page.
// A switch fades out, loads the next file, seeks it to the same moment and fades back in.
// spessasynth's sequencer only plays note-ons it reaches, so after a seek the notes already
// sounding are struck by hand (`held`: [channel, pitch, velocity, start, end]) and released by
// the sequencer's own note-offs, or by hand before the next seek.
const VENDOR = new URL("../vendor/design/sound/spessasynth/", import.meta.url);
const RAMP = 0.03;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Voice sounds (choir aahs, voice oohs, synth voice, voice lead, space voice pad) play as a flute:
// a song's sung melody written for a voice patch sounds better on a flute through the built-in sounds.
export const VOICES = new Set([52, 53, 54, 85, 91]);
export const VOICE_SOUND = 73;                   // Flute
/** A copy of a Standard MIDI File with every program change to a voice sound set to VOICE_SOUND. */
export function voicesAsFlute(binary) {
  const b = new Uint8Array(binary.slice(0));
  const u32 = (i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
  if (b.length < 14 || u32(0) !== 0x4d546864) return b.buffer;          // not a MIDI file: as it is
  let at = 8 + u32(4);
  const tracks = b[10] << 8 | b[11];
  for (let t = 0; t < tracks && at + 8 <= b.length; t++) {
    const end = Math.min(b.length, at + 8 + u32(at + 4));
    let i = at + 8, status = 0;
    const vlq = () => { let v = 0, c; do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && i < end); return v; };
    while (i < end) {
      vlq();
      let s = b[i];
      if (s & 0x80) i++; else s = status;                                  // running status
      if (s === 0xff) { i++; const len = vlq(); i += len; }                // vlq() moves i: read it first
      else if (s === 0xf0 || s === 0xf7) { const len = vlq(); i += len; }
      else {
        status = s;
        const kind = s & 0xf0;
        if (kind === 0xc0) { if ((s & 0x0f) !== 9 && VOICES.has(b[i])) b[i] = VOICE_SOUND; i += 1; }
        else if (kind === 0xd0) i += 1;
        else i += 2;
      }
    }
    at = end;
  }
  return b.buffer;
}

export function makeSynth(getSoundfont) {
  return {
    ctx: null, synth: null, seq: null, out: null, meter: null, ready: null, loaded: "", mode: "", running: false,
    op: 0, struck: [], level: 1, muted: [], restarted: 0,
    audio() {                                   // made inside the first click
      if (!this.ctx) this.ctx = new AudioContext();
      this.ctx.resume();
      return this.ctx;
    },
    init() {
      this.ready = this.ready || (async () => {
        this.audio();
        const lib = await import(new URL("spessasynth_lib.min.js", VENDOR).href);
        const sf = await getSoundfont();
        await this.ctx.audioWorklet.addModule(new URL("spessasynth_processor.min.js", VENDOR).href);
        const synth = new lib.WorkletSynthesizer(this.ctx);
        this.out = this.ctx.createGain();
        synth.connect(this.out);
        this.out.connect(this.ctx.destination);
        this.meter = this.ctx.createAnalyser();     // read by peak(): is anything sounding
        this.out.connect(this.meter);
        await synth.soundBankManager.addSoundBank(sf, "main");
        await synth.isReady;
        this.synth = synth;
        this.seq = new lib.Sequencer(synth, { skipToFirstNoteOn: false });
        this.seq.eventHandler.addEvent("songEnded", "page", () => { if (this.mode === "song") this.onended?.(); });
        this.seq.eventHandler.addEvent("timeChange", "page", (t) => {
          if (this.target != null && Math.abs(t - this.target) < 1e-3) this.target = null;
        });
      })();
      this.ready.catch(() => { this.ready = null; });      // a failed load can be tried again
      return this.ready;
    },
    fade(to) {
      const g = this.out.gain, now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, now + RAMP);
    },
    /** play `name` (bytes: an ArrayBuffer or a promise of one) from `at` (seconds, or a function
     * read after the fade-out). false: something newer came first. */
    async start(name, bytes, at, { loop = false, mode = "part", held = [], level = 1, mute = [] } = {}) {
      const my = ++this.op;
      if (typeof at === "number") this.aim(at);          // report it through the fade-out too
      await this.init();
      const binary = await bytes;
      if (my !== this.op) return false;
      if (this.running) {
        this.fade(0);
        await wait(RAMP * 1000);
        if (my !== this.op) return false;
      }
      this.release();
      if (this.loaded !== name) {
        this.seq.loadNewSongList([{ binary: voicesAsFlute(binary), fileName: name }]);
        this.loaded = name;
      }
      this.seq.loopCount = loop ? Infinity : 0;
      this.setMuted(mute);
      const from = typeof at === "function" ? at() : at;
      this.aim(from);
      this.seq.currentTime = from;
      this.seq.play();
      this.restarted = 0;
      for (const [c, p, v, s, e] of held) {        // after the seek, in message order
        if (s < from - 0.005 && e - from > 0.05 && !this.muted.includes(c)) {
          this.synth.noteOn(c, p, v); this.struck.push([c, p]); this.restarted++;
        }
      }
      this.mode = mode; this.running = true; this.level = level;
      this.fade(level);
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
    release() {
      for (const [c, p] of this.struck) this.synth.noteOff(c, p);
      this.struck = [];
    },
    /** the level of what plays now, faded (a switch between versions) */
    setLevel(level) {
      this.level = level;
      if (this.running) this.fade(level);
    },
    /** mute exactly these channels (song-a's kept tracks, when they are off) */
    setMuted(channels) {
      if (!this.synth) { this.muted = [...channels]; return; }
      for (let c = 0; c < 16; c++) {               // every channel, every time: a new file may reset them
        this.synth.midiChannels[c]?.setSystemParameter("isMuted", channels.includes(c));
      }
      this.muted = [...channels];
    },
    // spessasynth's Sequencer moves its time on the audio thread: after `currentTime = t` (and
    // play(), which counts from 0 until then) its getter gives the old time until the audio
    // thread answers with a "timeChange", a frame or so later. Until then `time` is the target,
    // so a head drawn from it never shows the old place (or 0) after a jump.
    target: null, targetUntil: 0,
    // `from` also keeps the last jump's place, for a head drawn as heard (heardTime)
    aim(t) { this.target = t; this.from = t; this.targetUntil = performance.now() + 1000; },
    from: 0,
    get time() {
      if (this.target != null && performance.now() < this.targetUntil) return this.target;
      return this.seq && this.loaded ? this.seq.currentTime : 0;
    },
    /** the output's peak right now (0 to 1): 0 means silence */
    peak() {
      if (!this.meter) return 0;
      const buf = new Float32Array(this.meter.fftSize);
      this.meter.getFloatTimeDomainData(buf);
      return buf.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    },
  };
}
