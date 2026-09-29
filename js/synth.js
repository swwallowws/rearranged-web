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
        this.seq.loadNewSongList([{ binary: binary.slice(0), fileName: name }]);
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
