// "In your browser": the engine as WebAssembly (pkg/, built from crates/rearranged-web) and
// this browser's storage. It answers what the local server answers, the same shapes, so the
// pages do not care where they run. Nothing is uploaded anywhere.
import init, * as engine from "../pkg/rearranged.js";
import { store } from "./store.js";

const TAGS = ["sounds like Song A", "sounds like Song B", "clashes", "too busy", "empty", "mechanical", "love it"];
let ready = null;
const loadEngine = () => (ready = ready || init());

const sessions = new Map();          // lab id -> engine.Session (a pair read once)
const building = new Map();          // lab id -> null while building, or the error
const stem = (name) => String(name || "").replace(/\.[^.]*$/, "");
const bytesOf = async (file) => new Uint8Array(await file.arrayBuffer());
const tick = () => new Promise((ok) => setTimeout(ok, 0));

// a short, stable name for a whole-song render's settings (FNV-1a, 40 bits)
function hashOf(text) {
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0").slice(0, 10);
}
// JSON with sorted keys, as json.dumps(..., sort_keys=True) orders them
const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

async function record(id) {
  const r = await store.get("labs", id);
  if (!r) throw new Error("no such project");
  return r;
}

async function session(r) {
  await loadEngine();
  if (!sessions.has(r.id)) {
    const i = r.inputs;
    sessions.set(r.id, new engine.Session(i.song, i.donor, JSON.stringify(i.parts), JSON.stringify(i.cfg),
                                          JSON.stringify(r.overrides || {})));
  }
  return sessions.get(r.id);
}

async function build(r) {
  sessions.delete(r.id);
  const s = await session(r);
  await tick();
  const built = s.build(r.part, r.id);
  const lab = JSON.parse(built.lab);
  await store.clear("files", `${r.id}/v`);
  for (const name of built.names) await store.put("files", built.file(name), `${r.id}/${name}`);
  built.free();
  return lab;
}

// The sounds: the design system's shared General MIDI bank (vendor/design/sound/gm.sf3,
// GeneralUser GS trimmed; see its NOTICE; `sync.sh <web> --sound` updates it), fetched once and
// kept in the Cache API, unless the visitor picked a soundfont of their own (kept in IndexedDB,
// as before). Bump BUILTIN_VERSION when a sync changes gm.sf3.
const BUILTIN_VERSION = "1";
const BUILTIN = new URL(`../vendor/design/sound/gm.sf3?v=${BUILTIN_VERSION}`, import.meta.url).href;
const BUILTIN_NAME = "built-in General MIDI (GeneralUser GS)";
const CACHE = "rearranged-soundfont";
let builtin = null;

async function soundfontRecord() {
  return store.get("meta", "soundfont");
}

function builtinBytes() {
  builtin = builtin || (async () => {
    let cache = null;
    try { cache = await caches.open(CACHE); } catch { /* no Cache API here: fetch every time */ }
    let res = cache && (await cache.match(BUILTIN));
    if (!res) {
      res = await fetch(BUILTIN);
      if (!res.ok) throw new Error(`the built-in sounds did not load (${res.status})`);
      if (cache) {
        for (const old of await cache.keys()) if (old.url !== BUILTIN) await cache.delete(old);
        await cache.put(BUILTIN, res.clone()).catch(() => {});
      }
    }
    return res.arrayBuffer();
  })();
  builtin.catch(() => { builtin = null; });            // a failed load can be tried again
  return builtin;
}

export function browserBackend() {
  return {
    where: "browser",
    async labs() {
      const all = (await store.all("labs")).filter((r) => r.lab);
      return all.sort((a, b) => b.at - a.at).map((r) => ({
        id: r.id, title: r.title, donor: r.donor, part: r.lab.part, versions: r.lab.variants.length, at: r.at }));
    },
    async guess(file, kind) {
      await loadEngine();
      return JSON.parse(engine.guess(await bytesOf(file), kind));
    },
    async partsPreview(song, donor, parts) {
      await loadEngine();
      const got = JSON.parse(engine.partsPreview(await bytesOf(song), await bytesOf(donor), parts ? await parts.text() : undefined));
      return { parts: got.parts, auto: got.auto, bars: got.bars, end: got.end };
    },
    async createLab({ song, donor, parts, songRoles, donorRoles, part }) {
      await loadEngine();
      const [s, d] = [await bytesOf(song), await bytesOf(donor)];
      const preview = JSON.parse(engine.partsPreview(s, d, parts ? await parts.text() : undefined));
      if (!(part >= 0 && part < preview.parts.length)) throw new Error(`there is no part ${+part + 1}`);
      const cfg = JSON.parse(engine.config(JSON.stringify(songRoles), JSON.stringify(donorRoles)));
      const id = "lab" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const r = { id, title: stem(song.name) || "song", donor: stem(donor.name), at: Date.now() / 1000, part: +part,
                  inputs: { song: s, donor: d, parts: preview.data, cfg }, overrides: {}, lab: null, ratings: {}, covers: {} };
      await store.put("labs", r);
      building.set(id, null);
      (async () => {
        try {
          r.lab = await build(r);
          await store.put("labs", r);
          building.delete(id);
        } catch (e) {
          building.set(id, e.message || String(e));
        }
      })();
      return { id };
    },
    async status(id) {
      if (building.has(id)) {
        const err = building.get(id);
        return { state: err ? "error" : "building", error: err };
      }
      const r = await store.get("labs", id);
      if (!r || !r.lab) throw new Error("no such project");
      return { state: "ready", error: null };
    },
    async lab(id) {
      const r = await record(id);
      if (!r.lab) throw new Error("no such project");
      const lab = r.lab;
      const variants = lab.variants.map((v) => ({ id: v.id, label: v.label, gain_db: v.gain_db, arr: v.arr, kept: v.kept,
        settings: Object.fromEntries(Object.keys(lab.factors).map((f) => [f, v.settings[f]])) }));
      return { id, part: lab.part, part_start: lab.part_start, part_end: lab.part_end, segments: lab.segments,
               variants: variants.sort((a, b) => a.label.localeCompare(b.label)), factors: lab.factors,
               ratings: r.ratings || {}, tags: TAGS, busy: building.has(id) && building.get(id) === null,
               error: r.error || null };
    },
    async roll(id, variant) {
      const r = await record(id);
      const v = r.lab.variants.find((x) => x.id === +variant);
      if (!v) throw new Error("no such version");
      await loadEngine();
      return JSON.parse(engine.roll(await store.get("files", `${id}/${v.arr}`), await store.get("files", `${id}/${v.kept}`)));
    },
    async coverRoll(id, stemName) {
      await loadEngine();
      const b = await store.get("files", `${id}/${stemName}.mid`);
      if (!b) throw new Error("no such cover");
      return JSON.parse(engine.roll(b, undefined));
    },
    async rate(id, variant, stars, tags) {
      const r = await record(id);
      if (stars && !(stars >= 1 && stars <= 5)) throw new Error("stars must be 1 to 5");
      if (!r.lab.variants.some((v) => v.id === +variant)) throw new Error(`no version ${variant}`);
      r.ratings = { ...(r.ratings || {}), [String(+variant)]: { stars: stars || null, tags: [...tags] } };
      await store.put("labs", r);
      return { ok: true };
    },
    async reveal(id) {
      const r = await record(id);
      await loadEngine();
      return JSON.parse(engine.reveal(JSON.stringify(r.lab), JSON.stringify(r.ratings || {})));
    },
    async parts(id) {
      return JSON.parse((await session(await record(id))).parts());
    },
    async covers(id) {
      const r = await record(id);
      return Object.entries(r.covers || {}).sort((a, b) => b[1].at - a[1].at)
        .map(([s, meta]) => ({ stem: s, settings: meta.settings, status: "done", midi: `${s}.mid` }));
    },
    async cover(id, body) {
      const r = await record(id);
      const choices = { bass: [body.bass ?? "song", ["song", "donor"]], guitar: [body.guitar ?? "picked", ["picked", "strummed"]],
                        drums: [body.drums ?? "song", ["donor", "song", "none"]], feel: [body.feel ?? "straight", ["straight", "half"]] };
      for (const [name, [value, allowed]] of Object.entries(choices)) {
        if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}; got '${value}'`);
      }
      const feelIn = {};
      for (const x of String(body.feel_in || "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const [p, f] = x.split("=");
        if (f === undefined) throw new Error("feel_in looks like 'verse=half,chorus=straight'");
        if (!["straight", "half"].includes(f.trim())) throw new Error("each part's feel must be straight or half");
        feelIn[p.trim()] = f.trim();
      }
      const settings = { bass: choices.bass[0], guitar: choices.guitar[0], lead: String(body.lead ?? "true").toLowerCase() === "true",
                         drums: choices.drums[0], feel: choices.feel[0], level: +(body.level ?? 64) || 64,
                         lead_in: String(body.lead_in || "").split(",").map((s) => s.trim()).filter(Boolean).sort(),
                         feel_in: sorted(feelIn), overrides: r.overrides || {} };
      const name = "cover" + hashOf(JSON.stringify(sorted(settings)));
      const done = { stem: name, status: "done", midi: `${name}.mid` };
      if (r.covers?.[name] && (await store.get("files", `${id}/${name}.mid`))) return done;
      const midi = (await session(r)).renderSong(JSON.stringify(settings));
      await store.put("files", midi, `${id}/${name}.mid`);
      r.covers = { ...(r.covers || {}), [name]: { settings, at: Date.now() / 1000 } };
      await store.put("labs", r);
      return done;
    },
    async chord(id, segment, name) {
      await loadEngine();
      const r = await record(id);
      engine.checkChord(name);                        // throws "not a chord name: ..."
      if (!r.lab.segments.some((s) => s.index === +segment)) throw new Error(`no chord ${segment} in this part`);
      if (building.has(id) && building.get(id) === null) throw new Error("still rebuilding");
      r.overrides = { ...(r.overrides || {}), [String(+segment)]: name };
      building.set(id, null);
      (async () => {
        try {
          r.lab = await build(r);
          r.error = null;
          await store.put("labs", r);
          building.delete(id);
        } catch (e) {
          r.error = e.message || String(e);
          await store.put("labs", r);
          building.delete(id);
        }
      })();
      return { started: true };
    },
    async fileBytes(id, name) {
      const b = await store.get("files", `${id}/${name}`);
      if (!b) throw new Error("no such file");
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    fileURL(id, name) {
      // a download link made on demand (see the page's download handler)
      return `#download:${id}/${name}`;
    },
    async download(id, name) {
      const b = await store.get("files", `${id}/${name}`);
      if (!b) return null;
      return URL.createObjectURL(new Blob([b], { type: "audio/midi" }));
    },
    /** the soundfont the lab plays with: the visitor's own if they picked one, else the built-in */
    async soundfont() {
      const sf = await soundfontRecord();
      if (sf) return sf.bytes.buffer ? sf.bytes.buffer.slice(0) : sf.bytes;
      return (await builtinBytes()).slice(0);
    },
    async soundfontInfo() {
      const sf = await soundfontRecord();
      return sf ? { name: sf.name, size: sf.bytes.byteLength, builtin: false } : { name: BUILTIN_NAME, builtin: true };
    },
    /** fetch the built-in sounds ahead of the first play (fills the cache) */
    prefetchSoundfont() {
      soundfontRecord().then((sf) => sf || builtinBytes()).catch(() => {});
    },
    async setSoundfont(file) {
      const bytes = await bytesOf(file);
      if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF") throw new Error("that is not a soundfont (.sf2 or .sf3)");
      await store.put("meta", { name: file.name, bytes }, "soundfont");
      return { name: file.name, size: bytes.byteLength, builtin: false };
    },
    /** back to the built-in sounds */
    async clearSoundfont() {
      await store.del("meta", "soundfont");
      return { name: BUILTIN_NAME, builtin: true };
    },
    /** one looping MIDI per version for the in-browser player (see js/synth.js) */
    async loops(id, lab) {
      await loadEngine();
      const out = {};
      const length = lab.part_end - lab.part_start;
      for (const v of lab.variants) {
        const lf = engine.loopFile(await store.get("files", `${id}/${v.arr}`), await store.get("files", `${id}/${v.kept}`), length);
        out[v.id] = { midi: lf.midi, ...JSON.parse(lf.info) };
        lf.free();
      }
      return out;
    },
    // the part plays through the in-browser synth, from one looping MIDI file per version
    audio: "midi",
  };
}
