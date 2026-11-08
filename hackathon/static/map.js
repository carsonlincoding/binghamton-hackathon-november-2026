// map.js - frontend logic. Talks to app.py with fetch().
const map = L.map("map", { preferCanvas: true }).setView([42.0987, -75.918], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

let picking = false, corners = [], box = null, locked = null, markers = [], assets = [], timer = null, runId = 0, cur = null;
const memo = new Map();  // remembers answers for storms already run, so switching back is instant
const mk = new Map();    // remembers map dots, so a re-score updates them instead of rebuilding them
const hidden = new Set();  // asset types the user switched off with the filter checkboxes
const $ = (id) => document.getElementById(id);
const COLORS = { high: "#C8372D", mid: "#E08A1E", low: "#3C8D5A" };
const levelOf = (r) => (r >= 60 ? "high" : r >= 30 ? "mid" : "low");
const NAMES = { substation: "Substation", hospital: "Hospital", fire_station: "Fire station",
                police: "Police station", water_works: "Water works", bridge: "Bridge" };

// Legend in the corner of the map.
const legend = L.control({ position: "bottomright" });
legend.onAdd = () => {
  const d = L.DomUtil.create("div", "legend");
  d.innerHTML = '<b>Risk</b><br><i style="background:#C8372D"></i>High 60%+<br><i style="background:#E08A1E"></i>Medium 30-59%' +
    '<br><i style="background:#3C8D5A"></i>Low<br><small>Bigger dot = higher priority</small>';
  return d;
};
legend.addTo(map);

// ---------- Search + area selection ----------
$("searchBtn").onclick = async () => {
  const q = $("searchBox").value.trim();
  if (!q) return;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q));
    const j = await r.json();
    if (j.length) map.setView([+j[0].lat, +j[0].lon], 14); else $("status").textContent = "Place not found.";
  } catch (e) { $("status").textContent = "Search is unavailable right now."; }
};
$("selectBtn").onclick = () => { picking = true; corners = []; $("status").textContent = "Click the first corner."; };
map.on("click", (e) => {
  if (!picking) return;
  corners.push(e.latlng);
  if (corners.length === 2) {
    picking = false;
    if (box) box.remove();
    box = L.rectangle(corners, { color: "#2F6DB5", fillOpacity: 0.05 }).addTo(map);
    $("lockBtn").disabled = false;
    $("status").textContent = "Happy with it? Lock the area.";
  } else { $("status").textContent = "Click the opposite corner."; }
});
$("lockBtn").onclick = () => {
  const b = box.getBounds();
  locked = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  $("runBtn").disabled = false; $("liveBtn").disabled = false;
  $("status").textContent = "Area locked. Build a storm, then run it.";
};

function showTab(name) {  // Setup and Results are separate tabs so nothing is hidden below the fold
  const r = name === "results";
  $("setupView").hidden = r; $("resultsView").hidden = !r;
  $("tabSetup").classList.toggle("on", !r); $("tabResults").classList.toggle("on", r);
  $("panel").scrollTop = 0;
}
$("tabSetup").onclick = () => showTab("setup");
$("tabResults").onclick = () => showTab("results");
$("viewBtn").onclick = () => {  // one click: use whatever the map is showing
  if (box) box.remove();
  box = L.rectangle(map.getBounds().pad(-0.1), { color: "#2F6DB5", fillOpacity: 0.05 }).addTo(map);
  $("lockBtn").disabled = false; $("lockBtn").click();
};

// ---------- Storm sliders, presets, live wind ----------
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
// Each storm has types: [name, plain-English description, slider values]. Keys match HAZARDS in risk_model.py.
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
try { if (location.hash.length > 1) setScenario(JSON.parse(decodeURIComponent(location.hash.slice(1)))); } catch (e) {}  // shared link

function spark(w) {  // tiny wind-over-time chart (inline SVG)
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

// ---------- Run + show results ----------
async function runStorm(quiet) {  // quiet = automatic re-score while you move a slider
  const my = ++runId;
  if (!quiet) { $("status").textContent = "Loading infrastructure..."; $("runBtn").disabled = true; $("runBtn").textContent = "Running..."; }
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
    if (my !== runId) return;  // a newer run has started, ignore this old answer
    if (data.error) { $("status").textContent = data.error; return; }
    assets = data.assets;
    $("detail").hidden = true;
    history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(sc)));  // makes the storm shareable via the page link
    if (!quiet) { mk.forEach((m) => m.remove()); mk.clear(); buildFilters(); }
    draw();
    if (!quiet) { $("tabResults").disabled = false; showTab("results"); }
    const ar = data.area;
    $("status").textContent = !assets.length ? "Nothing found here. Try a bigger area." :
      ar && ar.source ? `Using ${ar.structures} structures from the US Army Corps of Engineers inventory (about ${ar.people} residents).` :
      (ar && ar.note) || "Government building data was unavailable, so estimates are used.";
    $("status").textContent += ` Done in ${(data.ms / 1000).toFixed(1)} s${data.cached ? " (cached area)" : ""}.`;
  } catch (e) { $("status").textContent = "Could not reach the server. Is app.py still running?"; }
  finally { if (!quiet) { $("runBtn").disabled = false; $("runBtn").textContent = "Run the storm"; } }
}
$("runBtn").onclick = () => runStorm(false);
function autoRerun() {  // after the first run, changing the storm re-scores by itself
  if (!locked || !assets.length) return;
  clearTimeout(timer); timer = setTimeout(() => runStorm(true), 350);
}

function buildFilters() {  // one checkbox per asset type found
  const f = $("filters"); f.innerHTML = ""; hidden.clear();
  [...new Set(assets.map((a) => a.type))].forEach((t) => {
    const l = document.createElement("label"), c = document.createElement("input");
    l.className = "chk"; c.type = "checkbox"; c.checked = true;
    c.onchange = () => { c.checked ? hidden.delete(t) : hidden.add(t); draw(); };
    l.append(c, " " + NAMES[t]); f.appendChild(l);
  });
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
    if (m) { m.setStyle({ color: COLORS[lvl] }); m.setRadius(rad); m.setTooltipContent(`${a.name} (${a.risk}%)`); if (!map.hasLayer(m)) m.addTo(map); m.off("click"); }
    else { m = L.circleMarker([a.lat, a.lon], { radius: rad, color: COLORS[lvl], fillOpacity: 0.8 }).addTo(map).bindTooltip(`${a.name} (${a.risk}%)`); mk.set(id, m); }
    m.on("click", () => showDetail(a)); a.marker = m;
    const li = document.createElement("li");
    li.className = lvl; li.tabIndex = 0;  // tabIndex lets keyboard users reach it
    const nm = document.createElement("span"), ty = document.createElement("small"), pill = document.createElement("b");
    nm.className = "nm"; nm.textContent = a.name; ty.textContent = NAMES[a.type];
    pill.className = "pill " + lvl; pill.textContent = a.risk + "%";
    li.append(nm, ty, pill);
    const go = () => { map.flyTo([a.lat, a.lon], 17); showDetail(a); };
    li.onclick = go; li.onkeydown = (e) => { if (e.key === "Enter") go(); };
    frag.appendChild(li);
  });
  $("results").appendChild(frag);
  mk.forEach((m, id) => { if (!keep.has(id)) m.remove(); });
  const avg = shown.length ? Math.round(shown.reduce((s, a) => s + a.risk, 0) / shown.length) : 0;
  $("summary").innerHTML = shown.length ? `<div class="tile high"><b>${count.high}</b>High</div><div class="tile mid"><b>${count.mid}</b>Medium</div><div class="tile low"><b>${count.low}</b>Low</div><div class="tile"><b>${avg}%</b>Avg risk</div>` : "";

}

function plain(a) {  // one friendly sentence about this asset
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
  const x = document.createElement("button");
  x.className = "close"; x.textContent = "\u00d7"; x.setAttribute("aria-label", "Close details"); x.onclick = () => { d.hidden = true; };
  d.appendChild(x);
  const add = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; d.appendChild(e); return e; };
  add("h3", a.name);
  add("p", `${NAMES[a.type]}. Protect-first rank #${assets.indexOf(a) + 1} of ${assets.length}`, "meta");
  add("p", plain(a), "lead");
  add("div", `${a.risk}% chance of failure (likely ${a.risk_low}-${a.risk_high}%)`, "big");
  add("h4", "What could break it");
  Object.entries(a.breakdown).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).forEach(([k, v]) => {
    add("div", `${k}: ${v}%`, "bar").style.setProperty("--w", v + "%");
  });
  add("h4", "Facts");
  const MAT = { W: "wood frame", M: "masonry", S: "steel", H: "manufactured" };
  if (MAT[a.material]) add("p", `Built of ${MAT[a.material]}` + (a.levels ? `, ${a.levels} floors.` : "."));
  if (a.ground_elv != null) add("p", `Ground is ${Math.round(a.ground_elv)} ft above sea level` + (a.found_ht ? `, raised ${a.found_ht} ft` : "") + (a.firmzone ? `. FEMA flood zone ${a.firmzone}.` : "."));
  if (a.people_nearby) add("p", `About ${a.people_nearby} people live within 400 m.`);
  add("p", `Source: ${a.data_source || "OpenStreetMap"}. Confidence: ${a.confidence}` + (a.estimated.length ? ` (${a.estimated.join(", ")} guessed).` : "."), "note");
  d.hidden = false;
}

function stormBar() {  // shows the storm being run, with [edited] if the sliders no longer match the chosen type
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