const map = L.map("map", { preferCanvas: true }).setView([42.0987, -75.918], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

let picking = false, corners = [], box = null, preview = null, lockId = 0, locked = null, markers = [], assets = [], timer = null, runId = 0, cur = null;
const memo = new Map();
const mk = new Map();
const hidden = new Set();
const $ = (id) => document.getElementById(id);
const COLORS = { high: "#C8372D", mid: "#E08A1E", low: "#3C8D5A" };
const levelOf = (r) => (r >= 60 ? "high" : r >= 30 ? "mid" : "low");
const NAMES = { substation: "Substation", hospital: "Hospital", fire_station: "Fire station",
                police: "Police station", water_works: "Water works", bridge: "Bridge" };

const hl = L.layerGroup().addTo(map);
const legend = L.control({ position: "bottomright" });
legend.onAdd = () => {
  const d = L.DomUtil.create("div", "legend");
  d.innerHTML = '<b>Risk</b><br><i style="background:#C8372D"></i>High 60%+<br><i style="background:#E08A1E"></i>Medium 30-59%' +
    '<br><i style="background:#3C8D5A"></i>Low<br><small>Bigger dot = higher priority</small>' +
    '<hr><label>Overlay shows <select id="heatMode"><option value="risk">Damage risk</option><option value="recovery">Recovery time</option></select></label>' +
    '<label><input type="checkbox" id="heatToggle" checked> Show overlay</label>' +
    '<label>Strength <input type="range" id="heatOpacity" min="10" max="100" value="100"></label>' +
    '<small id="heatNote">Colors show predicted damage across the area.</small>';
  return d;
};
legend.addTo(map);

$("searchBtn").onclick = async () => {
  const q = $("searchBox").value.trim();
  if (!q) return;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q));
    const j = await r.json();
    if (j.length) map.setView([+j[0].lat, +j[0].lon], 14); else $("status").textContent = "Place not found.";
  } catch (e) { $("status").textContent = "Search is unavailable right now."; }
};
function sizeText(b) {
  const h = b.getNorth() - b.getSouth(), w = b.getEast() - b.getWest();
  const km = `${Math.round(w * 111 * Math.cos((b.getCenter().lat * Math.PI) / 180))} x ${Math.round(h * 111)} km`;
  const text = h > 0.3 || w > 0.3 ? "Very large area: only major bridges are shown, building details are estimated, and loading can take up to a minute."
    : h > 0.1 || w > 0.1 ? "Large area, so building details are estimated." : "Small enough for detailed building data.";
  return { tooBig: h > 1.0 || w > 1.0, text: `About ${km}. ` + text };
}
function setBox(bounds) {
  if (box) box.remove();
  box = L.rectangle(bounds, { color: "#2F6DB5", weight: 2, dashArray: "6 6", fillOpacity: 0.05 }).addTo(map);
  const info = sizeText(box.getBounds());
  $("lockBtn").disabled = info.tooBig;
  $("status").textContent = info.tooBig ? "Too large. Zoom in and draw a smaller box." : info.text + " Press Lock when ready.";
  return !info.tooBig;
}
function unlockArea(msg) {
  lockId++; locked = null;
  $("runBtn").disabled = true; $("liveBtn").disabled = true;
  const lb = $("lockBtn"); lb.textContent = "Lock"; lb.setAttribute("aria-pressed", "false"); lb.title = "";
  if (box) box.setStyle({ weight: 2, dashArray: "6 6" });
  $("detail").hidden = true; hl.clearLayers();
  if (msg) $("status").textContent = msg;
}
function lockArea() {
  const b = box.getBounds(), my = ++lockId;
  locked = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  $("runBtn").disabled = false; $("liveBtn").disabled = false;
  const lb = $("lockBtn"); lb.textContent = "Locked \u2713"; lb.setAttribute("aria-pressed", "true"); lb.title = "Click to unlock";
  box.setStyle({ weight: 3, dashArray: null });
  warm(my);
}
function stopPicking() {
  picking = false;
  if (preview) { preview.remove(); preview = null; }
  map.getContainer().classList.remove("picking");
}
$("lockBtn").onclick = () => {
  if (locked) unlockArea("Unlocked. Draw a new box, search, or use the map view.");
  else if (box) lockArea();
};
$("selectBtn").onclick = () => {
  unlockArea(); stopPicking();
  if (box) { box.remove(); box = null; }
  $("lockBtn").disabled = true;
  picking = true; corners = [];
  map.getContainer().classList.add("picking");
  $("status").textContent = "Click the first corner. Press Esc to cancel.";
};
map.on("click", (e) => {
  if (!picking) return;
  corners.push(e.latlng);
  if (corners.length === 2) { stopPicking(); setBox(corners); }
  else { $("status").textContent = "Click the opposite corner."; }
});
map.on("mousemove", (e) => {
  if (!picking || corners.length !== 1) return;
  if (preview) preview.setBounds([corners[0], e.latlng]);
  else preview = L.rectangle([corners[0], e.latlng], { color: "#2F6DB5", weight: 1, dashArray: "4 4", fillOpacity: 0.03, interactive: false }).addTo(map);
});

function showTab(name) {
  const r = name === "results";
  $("setupView").hidden = r; $("resultsView").hidden = !r;
  $("tabSetup").classList.toggle("on", !r); $("tabResults").classList.toggle("on", r);
  $("panel").scrollTop = 0;
}
$("tabSetup").onclick = () => showTab("setup");
$("tabResults").onclick = () => showTab("results");
$("viewBtn").onclick = () => {
  unlockArea(); stopPicking();
  if (setBox(map.getBounds().pad(-0.1))) lockArea();
};

const sliders = document.querySelectorAll(".hz");
const HZ = {};
sliders.forEach((s) => { HZ[s.dataset.key] = { label: s.dataset.label, unit: s.dataset.unit }; });
const readScenario = () => Object.fromEntries([...sliders].map((s) => [s.dataset.key, Number(s.value)]));
function setScenario(v) {
  sliders.forEach((s) => { s.value = v[s.dataset.key] || 0; $("val-" + s.dataset.key).textContent = s.value; });
  stormBar();
  autoRerun();
}
sliders.forEach((s) => { s.oninput = () => { $("val-" + s.dataset.key).textContent = s.value; stormBar(); autoRerun(); }; });

const STORMS = {
  thunderstorm: { name: "Thunderstorm", types: [
    ["Moderate", "Gusty wind and heavy rain. Power may flicker.", { wind: 45, rain: 1.5, lightning: 5 }],
    ["Severe", "Damaging wind, hail, and constant lightning.", { wind: 70, rain: 3, lightning: 9 }]] },
  hurricane: { name: "Hurricane", types: [
    ["Category 1", "Very dangerous winds. Roof and tree damage, outages for days.", { wind: 85, rain: 6, flood: 4, lightning: 2 }],
    ["Category 2", "Extremely dangerous. Major roof damage, widespread outages.", { wind: 105, rain: 8, flood: 6, lightning: 2 }],
    ["Category 3", "Major hurricane. Devastating damage, outages for weeks.", { wind: 125, rain: 10, flood: 8, lightning: 3 }],
    ["Category 4", "Catastrophic damage. Areas may be unlivable for weeks.", { wind: 145, rain: 12, flood: 12, lightning: 3 }],
    ["Category 5", "Catastrophic. Many buildings destroyed.", { wind: 170, rain: 15, flood: 16, lightning: 3 }]] },
  flood: { name: "Flood", types: [
    ["Minor", "Low spots and roads flood.", { rain: 3, flood: 3 }],
    ["Moderate", "Homes and some key buildings take water.", { rain: 5, flood: 6 }],
    ["Major", "Widespread flooding. Many roads and bridges closed.", { rain: 8, flood: 10 }]] },
  winter: { name: "Winter storm", types: [
    ["Snowstorm", "Heavy snow slows roads and repair crews.", { snow: 14, wind: 25 }],
    ["Ice storm", "Ice weighs down power lines. Long outages.", { ice: 0.8, snow: 3, wind: 30 }],
    ["Blizzard", "Deep snow and strong wind. Travel stops.", { snow: 30, wind: 50 }]] },
  nor: { name: "Nor'easter", types: [
    ["Typical", "Strong wind, rain, and some snow with coastal flooding.", { wind: 50, rain: 2, snow: 6, flood: 2 }],
    ["Strong", "Damaging wind, heavy snow, and real flooding.", { wind: 75, rain: 4, snow: 18, flood: 5 }]] },
  quake: { name: "Earthquake", types: [
    ["Strong", "Shaking is felt everywhere. Light damage.", { quake: 6 }],
    ["Heavy", "Real damage to older buildings and bridges.", { quake: 8 }],
    ["Severe", "Major damage and collapses.", { quake: 10 }]] },
  heat: { name: "Heat wave", types: [
    ["Hot", "High demand on the power grid.", { heat: 15 }],
    ["Extreme", "Grid equipment may overload.", { heat: 30 }]] },
};
function pickType(storm, i) {
  const [name, desc, vals] = STORMS[storm].types[i];
  cur = { storm, i };
  setScenario(vals);
  $("stormInfo").textContent = `${STORMS[storm].name}, ${name}: ${desc}`;
  document.querySelectorAll("#types .chip").forEach((c, j) => c.classList.toggle("on", j === i));
}
function pickStorm(storm) {
  document.querySelectorAll("#presets .chip").forEach((c) => c.classList.toggle("on", c.dataset.storm === storm));
  const t = $("types"); t.innerHTML = "";
  STORMS[storm].types.forEach(([name], i) => {
    const c = document.createElement("button"); c.className = "chip"; c.textContent = name; c.onclick = () => pickType(storm, i); t.appendChild(c);
  });
  pickType(storm, 0);
}
Object.keys(STORMS).forEach((k) => {
  const c = document.createElement("button"); c.className = "chip"; c.dataset.storm = k; c.textContent = STORMS[k].name;
  c.onclick = () => pickStorm(k); $("presets").appendChild(c);
});
const reset = document.createElement("button"); reset.className = "chip"; reset.textContent = "Reset";
reset.onclick = () => { cur = null; setScenario({}); $("types").innerHTML = ""; $("stormInfo").textContent = ""; document.querySelectorAll("#presets .chip").forEach((c) => c.classList.remove("on")); };
$("presets").appendChild(reset);
try { if (location.hash.length > 1) setScenario(JSON.parse(decodeURIComponent(location.hash.slice(1)))); } catch (e) {}

function spark(w) {
  if (!w || w.length < 2) { $("spark").innerHTML = ""; return; }
  const mx = Math.max(...w, 1);
  const pts = w.map((v, i) => `${(i * 200) / (w.length - 1)},${40 - (v / mx) * 36}`).join(" ");
  $("spark").innerHTML = `<svg viewBox="0 0 200 44" role="img" aria-label="Wind over the next 24 hours"><polyline points="${pts}" fill="none" stroke="#2F6DB5" stroke-width="2"/></svg><small>Wind, next 24 h (peak ${mx} mph)</small>`;
}
$("liveBtn").onclick = async () => {
  $("status").textContent = "Loading live forecast...";
  const res = await fetch("/api/live-wind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(locked) });
  const f = await res.json();
  if (f.error) { $("status").textContent = f.error; return; }
  setScenario({ ...readScenario(), wind: f.wind_mph });
  spark(f.hourly_winds);
  const when = f.peak_time ? " around " + new Date(f.peak_time).toLocaleTimeString([], { hour: "numeric" }) : "";
  $("status").textContent = (f.live ? "Live NWS forecast" : "Offline default") + `: peak wind ${f.wind_mph} mph${when}.` +
    (f.alerts.length ? " Alerts: " + f.alerts.join(", ") + "." : "");
};

async function runStorm(quiet) {
  if (!locked) return;
  const my = ++runId;
  if (!quiet) { $("status").textContent = "Loading infrastructure..."; $("runBtn").disabled = true; $("runBtn").textContent = "Running..."; $("runBtn").classList.add("busy"); }
  try {
    const sc = readScenario();
    const key = JSON.stringify([locked, sc]);
    const hit = memo.get(key);
    let data = hit ? { ...hit, ms: 0, cached: true } : null;
    if (!data) {
      const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...locked, scenario: sc }) });
      data = await res.json();
      if (!data.error) { memo.set(key, data); if (memo.size > 20) memo.delete(memo.keys().next().value); }
    }
    if (my !== runId) return;
    if (data.error) { $("status").textContent = data.error; return; }
    assets = data.assets;
    $("detail").hidden = true; hl.clearLayers();
    history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(sc)));
    if (!quiet) { mk.forEach((m) => m.remove()); mk.clear(); buildFilters(); }
    draw();
    if (!quiet) { $("tabResults").disabled = false; showTab("results"); }
    const ar = data.area;
    $("status").textContent = !assets.length ? "Nothing found here. Try a bigger area." :
      ar && ar.source ? `Using ${ar.structures} structures from the US Army Corps of Engineers inventory (about ${ar.people} residents).` :
      (ar && ar.note) || "Government building data was unavailable, so estimates are used.";
    $("status").textContent += ` Done in ${(data.ms / 1000).toFixed(1)} s${data.cached ? " (cached area)" : ""}.`;
  } catch (e) { $("status").textContent = "Could not reach the server. Is app.py still running?"; }
  finally { if (!quiet) { $("runBtn").disabled = !locked; $("runBtn").textContent = "Run the storm"; $("runBtn").classList.remove("busy"); } }
}
$("runBtn").onclick = () => runStorm(false);
function autoRerun() {
  if (!locked || !assets.length) return;
  clearTimeout(timer); timer = setTimeout(() => runStorm(true), 350);
}

function buildFilters() {
  const f = $("filters"); f.innerHTML = ""; hidden.clear();
  [...new Set(assets.map((a) => a.type))].forEach((t) => {
    const l = document.createElement("label"), c = document.createElement("input");
    l.className = "chk"; c.type = "checkbox"; c.checked = true;
    c.onchange = () => { c.checked ? hidden.delete(t) : hidden.add(t); draw(); };
    l.append(c, " " + NAMES[t]); f.appendChild(l);
  });
}

function tip(a) {
  const e = document.createElement("span");
  e.textContent = a.name + " ";
  const r = document.createElement("b");
  r.className = "tip-risk " + levelOf(a.risk); r.textContent = a.risk + "%";
  e.appendChild(r);
  return e;
}

function draw() {
  const keep = new Set();
  $("results").innerHTML = "";
  const shown = assets.filter((a) => !hidden.has(a.type));
  const count = { high: 0, mid: 0, low: 0 };
  const frag = document.createDocumentFragment();
  shown.forEach((a) => {
    const lvl = levelOf(a.risk); count[lvl]++;
    const id = a.name + "|" + a.lat + "|" + a.lon; keep.add(id);
    const rad = 6 + Math.min(a.priority, 100) / 8;
    let m = mk.get(id);
    if (m) { m.setStyle({ color: COLORS[lvl] }); m.setRadius(rad); m.setTooltipContent(tip(a)); if (!map.hasLayer(m)) m.addTo(map); m.off("click"); }
    else { m = L.circleMarker([a.lat, a.lon], { radius: rad, color: COLORS[lvl], fillOpacity: 0.8 }).addTo(map).bindTooltip(tip(a)); mk.set(id, m); }
    m.on("click", () => showDetail(a)); a.marker = m;
    const li = document.createElement("li");
    li.className = lvl; li.tabIndex = 0; a.li = li;
    const nm = document.createElement("span"), ty = document.createElement("small"), pill = document.createElement("b");
    nm.className = "nm"; nm.textContent = a.name; ty.textContent = NAMES[a.type];
    pill.className = "pill " + lvl; pill.textContent = a.risk + "%";
    li.append(nm, ty, pill);
    const go = () => { map.flyTo([a.lat, a.lon], 17, { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches }); showDetail(a); };
    li.onclick = go; li.onkeydown = (e) => { if (e.key === "Enter") go(); };
    frag.appendChild(li);
  });
  $("results").appendChild(frag);
  mk.forEach((m, id) => { if (!keep.has(id)) m.remove(); });
  heat.setData(shown, locked);
  const avg = shown.length ? Math.round(shown.reduce((s, a) => s + a.risk, 0) / shown.length) : 0;
  $("summary").innerHTML = shown.length ? `<div class="tile high"><b>${count.high}</b>High</div><div class="tile mid"><b>${count.mid}</b>Medium</div><div class="tile low"><b>${count.low}</b>Low</div><div class="tile"><b>${avg}%</b>Avg risk</div>` : "";

}

function plain(a) {
  const word = { high: "Very likely to fail", mid: "Could fail", low: "Probably holds up" }[levelOf(a.risk)];
  const top = Object.entries(a.breakdown).sort((x, y) => y[1] - x[1])[0];
  const why = top && top[1] > 0 ? ` Biggest danger: ${top[0].toLowerCase()}.` : "";
  const time = a.recovery_hrs >= 48 ? `about ${Math.round(a.recovery_hrs / 24)} days` : `about ${a.recovery_hrs} hours`;
  const fix = a.risk >= 30 && a.recovery_hrs > 0 ? ` If it fails, expect ${time} to restore.` : "";
  const dep = a.depends_on ? ` It also depends on power from "${a.depends_on}".` : "";
  return word + "." + why + fix + dep;
}

function showDetail(a) {
  const d = $("detail"); d.innerHTML = ""; d.className = "lvl-" + levelOf(a.risk);
  highlight(a);
  const x = document.createElement("button");
  x.className = "close"; x.textContent = "\u00d7"; x.setAttribute("aria-label", "Close details"); x.onclick = () => { d.hidden = true; hl.clearLayers(); };
  d.appendChild(x);
  const add = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; d.appendChild(e); return e; };
  add("h3", a.name);
  add("p", `${NAMES[a.type]}. Protect-first rank #${assets.indexOf(a) + 1} of ${assets.length}`, "meta");
  const lead = add("p", "", "lead"), text = plain(a), cut = text.indexOf(".") + 1;
  const verdict = document.createElement("span");
  verdict.className = "verdict"; verdict.textContent = text.slice(0, cut);
  lead.append(verdict, text.slice(cut));
  add("div", `${a.risk}% chance of failure (likely ${a.risk_low}-${a.risk_high}%)`, "big");
  add("h4", "What could break it");
  Object.entries(a.breakdown).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).forEach(([k, v]) => {
    add("div", `${k}: ${v}%`, "bar").style.setProperty("--w", v + "%");
  });
  renderFixes(a, d);
  add("h4", "Facts");
  const MAT = { W: "wood frame", M: "masonry", S: "steel", H: "manufactured" };
  if (MAT[a.material]) add("p", `Built of ${MAT[a.material]}` + (a.levels ? `, ${a.levels} floors.` : "."));
  if (a.ground_elv != null) add("p", `Ground is ${Math.round(a.ground_elv)} ft above sea level` + (a.found_ht ? `, raised ${a.found_ht} ft` : "") + (a.firmzone ? `. FEMA flood zone ${a.firmzone}.` : "."));
  if (a.people_nearby) add("p", `About ${a.people_nearby} people live within 400 m.`);
  add("p", `Source: ${a.data_source || "OpenStreetMap"}. Confidence: ${a.confidence}` + (a.estimated.length ? ` (${a.estimated.join(", ")} guessed).` : "."), "note");
  document.querySelectorAll("#results li.sel").forEach((x) => x.classList.remove("sel"));
  if (a.li) { a.li.classList.add("sel"); a.li.scrollIntoView({ block: "nearest" }); }
  d.hidden = false;
}

function stormBar() {
  const sc = readScenario();
  const same = (a, b) => Object.keys(a).every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 0.05);
  const active = Object.entries(sc).filter(([, v]) => v > 0);
  let name = "No storm set", edited = false;
  if (cur) {
    const [tn, , vals] = STORMS[cur.storm].types[cur.i];
    name = `${STORMS[cur.storm].name}, ${tn}`; edited = !same(sc, vals);
  } else if (active.length) {
    name = "Custom storm";
    for (const k in STORMS) STORMS[k].types.forEach(([tn, , vals]) => { if (same(sc, vals)) name = `${STORMS[k].name}, ${tn}`; });
  }
  $("sbName").textContent = name; $("sbEdit").hidden = !edited;
  $("sbFacts").textContent = active.length ? active.map(([k, v]) => `${HZ[k].label} ${v} ${HZ[k].unit}`).join(" \u00b7 ") : "Pick a storm or move a slider.";
  const tag = $("stormTag"); tag.hidden = !active.length; tag.textContent = name + (edited ? " [edited]" : "");
}
stormBar();

async function warm(my) {
  const start = runId;
  try {
    $("status").textContent = "Getting area data...";
    const r = await fetch("/api/warm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(locked) });
    const j = await r.json();
    if (runId === start && lockId === my) $("status").textContent = j.error || `Area ready: ${j.count} assets found. Pick a storm and run it.`;
  } catch (e) { if (runId === start && lockId === my) $("status").textContent = "Area locked. Pick a storm and run it."; }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("detail").hidden = true; hl.clearLayers(); if (picking) { stopPicking(); $("status").textContent = "Drawing cancelled."; } } });

$("csvBtn").onclick = () => {
  const q = (v) => {
    let t = String(v ?? "");
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const rows = [["Rank", "Name", "Type", "Risk %", "Low %", "High %", "Hours to recover (est.)", "Main threat", "People within 400 m", "Data source"]];
  assets.forEach((a, i) => {
    const top = Object.entries(a.breakdown).sort((x, y) => y[1] - x[1])[0];
    rows.push([i + 1, a.name, NAMES[a.type], a.risk, a.risk_low, a.risk_high, a.recovery_hrs, top && top[1] ? top[0] : "", a.people_nearby, a.data_source]);
  });
  const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = "storm-results.csv"; link.click();
  URL.revokeObjectURL(link.href);
};

function highlight(a) {
  hl.clearLayers();
  const r = (a.marker ? a.marker.getRadius() : 8) + 8;
  L.circle([a.lat, a.lon], { radius: 400, color: "#000", weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(hl);
  L.circleMarker([a.lat, a.lon], { radius: r, color: "#fff", weight: 8, fill: false, interactive: false }).addTo(hl);
  L.circleMarker([a.lat, a.lon], { radius: r, color: "#000", weight: 4, fill: false, interactive: false }).addTo(hl);
}

const FIX_TABLE = {
  "Flood / storm surge": { bridge: ["Raise or reinforce the approaches and clear the drainage", "$$$", 0.5],
    default: ["Install flood barriers and lift key equipment above flood level", "$$", 0.35] },
  "Wind speed": { bridge: ["Inspect and reinforce railings, signs, and joints", "$$", 0.7],
    substation: ["Reinforce poles and structures, and trim nearby trees", "$$", 0.6],
    default: ["Add roof ties and shutters, and secure rooftop equipment", "$$", 0.6] },
  "Rainfall (24 h)": { default: ["Clear storm drains and improve drainage before the storm", "$", 0.6] },
  "Ice buildup": { substation: ["Add de-icing, sturdier lines, and spare parts on site", "$$", 0.5],
    bridge: ["Pre-treat the deck and keep salt crews on standby", "$", 0.6],
    default: ["Keep roofs and access routes clear, and stock salt", "$", 0.7] },
  "Snowfall": { default: ["Set plowing priority and check roof load limits", "$", 0.7] },
  "Lightning": { substation: ["Install or test surge arresters and grounding", "$$", 0.4],
    default: ["Add surge protection for key equipment", "$", 0.5] },
  "Heat above normal": { substation: ["Add cooling and reduce load with demand response", "$$", 0.6],
    default: ["Service cooling systems and plan backup cooling", "$", 0.7] },
  "Earthquake shaking": { bridge: ["Retrofit bearings and add restrainers", "$$$", 0.5],
    default: ["Brace equipment and review the building for seismic upgrades", "$$", 0.6] },
};

function riskWith(a, mult, casc) {
  const own = Object.values(a.breakdown).reduce((s, v) => s * (1 - v / 100), 1);
  const x = own > 0 ? Math.max(0, 1 - (1 - a.risk / 100) / own) : 0;
  const surv = Object.entries(a.breakdown).reduce((s, [k, v]) => s * (1 - (v / 100) * (mult[k] ?? 1)), 1);
  return 100 * (1 - surv * (1 - x * casc));
}

function fixContext(a, label) {
  if (label === "Flood / storm surge" && a.ground_elv != null && a.base_elev != null)
    return ` It sits about ${Math.max(0, Math.round(a.ground_elv - a.base_elev))} ft above the nearest low ground` + (a.firmzone ? ` (FEMA zone ${a.firmzone}).` : ".");
  if (label === "Wind speed" && (a.material === "W" || a.material === "H")) return " Wood or manufactured construction is more wind-prone.";
  return "";
}

function fixes(a) {
  const items = [];
  const base = riskWith(a, {}, 1);
  Object.entries(a.breakdown).filter(([, v]) => v >= 12).forEach(([label, v]) => {
    const row = FIX_TABLE[label];
    if (!row) return;
    const [title, cost, m] = row[a.type] || row.default;
    items.push({ title, cost, why: `${label} alone gives a ${v}% failure chance here.` + fixContext(a, label), mult: { [label]: m }, casc: 1 });
  });
  if (a.depends_on && a.cascade >= 5) {
    items.push({ title: a.type === "hospital" ? "Test the backup generator and stock 72+ hours of fuel" : "Add a backup generator or a second power feed",
      cost: "$$", why: `Losing power at "${a.depends_on}" adds ${a.cascade} points of risk.`, mult: {}, casc: 0.25 });
  }
  items.forEach((f) => { f.after = Math.round(Math.max(0, a.risk - Math.max(0, base - riskWith(a, f.mult, f.casc)))); });
  items.sort((p, q) => p.after - q.after);
  const top = items.slice(0, 4);
  const allMult = {}; let allCasc = 1;
  top.forEach((f) => { Object.entries(f.mult).forEach(([k, m]) => { allMult[k] = (allMult[k] ?? 1) * m; }); allCasc = Math.min(allCasc, f.casc); });
  const allAfter = top.length > 1 ? Math.round(Math.max(0, a.risk - Math.max(0, base - riskWith(a, allMult, allCasc)))) : null;
  const extra = [];
  if (a.risk >= 30 && a.recovery_hrs >= 24) {
    const fmt = (h) => (h >= 48 ? Math.round(h / 24) + " days" : Math.round(h) + " hours");
    extra.push({ title: "Pre-arrange repair crews and spare parts", cost: "$", why: `Fixing it could take ${fmt(a.recovery_hrs)}.`, note: `Recovery: ${fmt(a.recovery_hrs)} to about ${fmt(a.recovery_hrs * 0.6)}` });
  }
  if (a.risk >= 30 && a.people_nearby >= 500) {
    extra.push({ title: "Plan shelter or evacuation for nearby residents", cost: "$", why: `About ${a.people_nearby} people live within 400 m.`, note: "Does not change the failure chance, but protects people." });
  }
  return { items: top, extra, allAfter };
}

const rk = (text, v) => {
  const e = document.createElement("span");
  e.className = "rk " + levelOf(v); e.textContent = text;
  return e;
};

function renderFixes(a, d) {
  const h = document.createElement("h4"); h.textContent = "Possible solutions for this spot"; d.appendChild(h);
  const { items, extra, allAfter } = fixes(a);
  const all = items.concat(extra);
  if (!all.length) {
    const p = document.createElement("p"); p.textContent = "Low risk in this storm. Try a stronger one to see what would help."; d.appendChild(p); return;
  }
  all.forEach((f) => {
    const box = document.createElement("div"); box.className = "fix";
    const t = document.createElement("b"); t.textContent = f.title;
    const c = document.createElement("small"); c.className = "cost"; c.textContent = f.cost;
    const w = document.createElement("p"); w.textContent = f.why;
    const r = document.createElement("div"); r.className = "delta";
    if (f.note) r.textContent = f.note;
    else r.append("Risk ", rk(a.risk + "%", a.risk), " to about ", rk(f.after + "%", f.after));
    box.append(t, c, w, r); d.appendChild(box);
  });
  if (allAfter !== null) {
    const p = document.createElement("p"); p.className = "lead fixsum";
    p.append("Doing all the risk fixes: ", rk(a.risk + "%", a.risk), " to about ", rk(allAfter + "%", allAfter), "."); d.appendChild(p);
  }
  const n = document.createElement("p"); n.className = "note"; n.textContent = "$ low, $$ medium, $$$ high cost. Effects are assumed demo values, not engineering estimates."; d.appendChild(n);
}

$("searchBox").addEventListener("keydown", (e) => { if (e.key === "Enter") $("searchBtn").click(); });

const HEAT_STOPS = [[0, [60, 141, 90]], [20, [60, 141, 90]], [35, [224, 138, 30]], [50, [224, 138, 30]], [65, [200, 55, 45]], [100, [200, 55, 45]]];
function heatColor(v) {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [v1, c1] = HEAT_STOPS[i - 1], [v2, c2] = HEAT_STOPS[i];
    if (v <= v2) { const t = v2 === v1 ? 0 : (v - v1) / (v2 - v1); return c1.map((c, k) => Math.round(c + (c2[k] - c) * t)); }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1];
}
function heatField(P, w, h, s, rect) {

  const out = new Uint8ClampedArray(w * h * 4), s2 = s * s;
  const ya = Math.max(0, Math.floor(rect[1])), yb = Math.min(h, Math.ceil(rect[3]));
  const xa = Math.max(0, Math.floor(rect[0])), xb = Math.min(w, Math.ceil(rect[2]));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      let ws = 0, vs = 0;
      for (let n = 0; n < P.length; n++) {
        const dx = x - P[n][0], dy = y - P[n][1], wt = 1 / (dx * dx + dy * dy + s2);
        ws += wt; vs += wt * P[n][2];
      }
      const v = Math.round(vs / ws / 10) * 10, c = heatColor(v), i = (y * w + x) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
      out[i + 3] = Math.round(255 * (0.3 + 0.7 * (v / 100)));
    }
  }
  return out;
}

map.createPane("heat");
map.getPane("heat").style.zIndex = 390;
map.getPane("heat").style.pointerEvents = "none";
const heat = {
  on: true, opacity: 1, mode: "risk", pts: [], bounds: null, frame: 0,
  canvas: L.DomUtil.create("canvas", "leaflet-zoom-hide", map.getPane("heat")),
  small: document.createElement("canvas"),
  setData(list, box) { this.pts = list; this.bounds = box; this.schedule(); },
  schedule() { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.draw()); },
  value(a) { return this.mode === "recovery" ? Math.min(100, (a.recovery_hrs / 96) * 100) : a.risk; },
  draw() {
    const size = map.getSize(), c = this.canvas, CELL = 10;
    c.width = size.x; c.height = size.y;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    if (!this.on || !this.pts.length) return;
    const lats = this.pts.map((a) => a.lat), lons = this.pts.map((a) => a.lon);
    const b = this.bounds || { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lons), west: Math.min(...lons) };
    const nw = map.latLngToContainerPoint([b.north, b.west]), se = map.latLngToContainerPoint([b.south, b.east]);
    const w = Math.ceil(size.x / CELL), h = Math.ceil(size.y / CELL);
    const spacing = Math.sqrt((Math.abs(se.x - nw.x) * Math.abs(se.y - nw.y)) / Math.max(1, this.pts.length));
    const s = Math.max(spacing * 0.4, 16) / CELL;
    const P = this.pts.map((a) => { const p = map.latLngToContainerPoint([a.lat, a.lon]); return [p.x / CELL, p.y / CELL, this.value(a)]; });
    const sc = this.small; sc.width = w; sc.height = h;
    sc.getContext("2d").putImageData(new ImageData(heatField(P, w, h, s, [nw.x / CELL, nw.y / CELL, se.x / CELL, se.y / CELL]), w, h), 0, 0);
    const ctx = c.getContext("2d");
    ctx.save();
    ctx.beginPath(); ctx.rect(nw.x, nw.y, se.x - nw.x, se.y - nw.y); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(sc, 0, 0, w, h, 0, 0, w * CELL, h * CELL);
    ctx.restore();
  },
};
map.on("moveend zoomend resize", () => heat.schedule());
L.DomEvent.disableClickPropagation(legend.getContainer());
$("heatToggle").onchange = (e) => { heat.on = e.target.checked; heat.schedule(); };
$("heatOpacity").oninput = (e) => { heat.opacity = e.target.value / 100; heat.schedule(); };
$("heatMode").onchange = (e) => {
  heat.mode = e.target.value;
  $("heatNote").textContent = heat.mode === "risk" ? "Colors show predicted damage across the area." : "Colors show how long recovery could take (green fast, red slow).";
  heat.schedule();
};