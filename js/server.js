// "This computer": the local server (rearranged-web), called exactly as the pages always have.
// `base` is "" when the page came from the server itself, or its address (CORS) otherwise.

export function serverBackend(base) {
  const url = (path) => `${base}${path}`;
  const api = async (path, opts) => {
    const r = await fetch(url(path), opts);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.detail || r.statusText || `${r.status}`);
    return b;
  };
  const form = (o) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) f.append(k, v);
    return f;
  };
  const post = (path, o) => api(path, { method: "POST", body: form(o) });
  const bytes = async (path) => {
    const r = await fetch(url(path));
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.arrayBuffer();
  };
  return {
    where: "computer",
    base,
    labs: () => api("/api/labs"),
    guess: (file, kind) => post("/api/guess", { file, kind }),
    partsPreview: (song, donor, parts) => post("/api/parts", { song, donor, parts }),
    createLab: ({ song, donor, parts, songRoles, donorRoles, part }) =>
      post("/api/labs", { song, donor, parts, song_roles: JSON.stringify(songRoles),
                          donor_roles: JSON.stringify(donorRoles), part }),
    status: (id) => api(`/api/labs/${id}/status`),
    lab: (id) => api(`/api/labs/${id}?open=1`),
    roll: (id, v) => api(`/api/labs/${id}/roll/${v}`),
    coverRoll: (id, stem) => api(`/api/labs/${id}/covers/${stem}/roll`),
    rate: (id, variant, stars, tags) => post(`/api/labs/${id}/rate`, { variant, tags: tags.join(","), stars: stars || undefined }),
    reveal: (id) => api(`/api/labs/${id}/reveal`),
    parts: (id) => api(`/api/labs/${id}/parts`),
    covers: (id) => api(`/api/labs/${id}/covers`),
    cover: (id, body) => post(`/api/labs/${id}/cover`, body),
    chord: (id, segment, name) => post(`/api/labs/${id}/chord`, { segment, name }),
    fileURL: (id, name) => url(`/api/labs/${id}/files/${name}`),
    fileBytes: (id, name) => bytes(`/api/labs/${id}/files/${name}?t=${Date.now()}`),
    soundfont: (id) => bytes(`/api/labs/${id}/soundfont`),
    // the server rendered every version to audio: the part plays from those files
    audio: "files",
  };
}
