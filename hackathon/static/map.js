const map = L.map("map").setView([42.0987, -75.918], 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

let picking = false, corners = [], box = null, locked = null, markers = [];
const $ = (id) => document.getElementById(id);

$("selectBtn").onclick = () => { picking = true; corners = []; $("status").textContent = "Click the first corner."; };
map.on("click", (e) => {
  if (!picking) return;
  corners.push(e.latlng);
  if (corners.length === 2) {
    picking = false;
    if (box) box.remove();
    box = L.rectangle(corners, { color: "#2F6DB5" }).addTo(map);
    $("lockBtn").disabled = false;
    $("status").textContent = "Happy with it? Lock the area.";
  } else { $("status").textContent = "Click the opposite corner."; }
});
$("lockBtn").onclick = () => {
  const b = box.getBounds();
  locked = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  $("runBtn").disabled = false;
  $("liveBtn").disabled = false;
  $("status").textContent = "Area locked. Build a storm, then run it.";
};

const sliders = document.querySelectorAll(".hz");

function readScenario() {
  const s = {};
  sliders.forEach((sl) => { s[sl.dataset.key] = Number(sl.value); });
  return s;
}
function setScenario(values) {
  sliders.forEach((sl) => {
    sl.value = values[sl.dataset.key] || 0;
    $("val-" + sl.dataset.key).textContent = sl.value;
  });
}
sliders.forEach((sl) => { sl.oninput = () => { $("val-" + sl.dataset.key).textContent = sl.value; }; });

const PRESETS = {
  thunderstorm: { wind: 60, rain: 3, lightning: 8 },
  flash:        { wind: 30, rain: 8, flood: 6, lightning: 3 },
  nor:          { wind: 70, rain: 4, flood: 4, snow: 18 },
  ice:          { wind: 35, ice: 1, snow: 6 },
  hurricane:    { wind: 130, rain: 12, flood: 10, lightning: 4 },
  clear:        {},
};
document.querySelectorAll("[data-preset]").forEach((b) => {
  b.onclick = () => setScenario(PRESETS[b.dataset.preset]);
});

$("liveBtn").onclick = async () => {
  $("status").textContent = "Loading live forecast...";
  const res = await fetch("/api/live-wind", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(locked) });
  const f = await res.json();
  if (f.error) { $("status").textContent = f.error; return; }
  const current = readScenario();
  current.wind = f.wind_mph;
  setScenario(current);
  const when = f.peak_time ? " around " + new Date(f.peak_time).toLocaleTimeString([], { hour: "numeric" }) : "";
  const alerts = f.alerts.length ? " Alerts: " + f.alerts.join(", ") + "." : "";
  $("status").textContent = (f.live ? "Live NWS forecast" : "Offline default (weather service unreachable)") +
    `: peak wind ${f.wind_mph} mph${when}.${alerts}`;
};

$("runBtn").onclick = async () => {
  $("status").textContent = "Loading infrastructure...";
  try {
    const res = await fetch("/api/analyze", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...locked, scenario: readScenario() }) });
    const data = await res.json();
    if (data.error) { $("status").textContent = data.error; return; }
    draw(data.assets);
  } catch (err) {
    $("status").textContent = "Could not reach the server. Is app.py still running?";
  }
};

function draw(assets) {
  markers.forEach((m) => m.remove()); markers = [];
  $("results").innerHTML = "";
  const count = { high: 0, mid: 0, low: 0 };
  $("status").textContent = assets.length ? "" : "No hospitals, fire stations, substations, or bridges found here. Try a bigger area.";

  assets.forEach((a) => {
    const level = a.risk >= 60 ? "high" : a.risk >= 30 ? "mid" : "low";
    count[level]++;
    const color = { high: "#C8372D", mid: "#E08A1E", low: "#3C8D5A" }[level];
    const popup = document.createElement("div");
    popup.textContent = `${a.name}: risk ${a.risk}%`;
    markers.push(L.circleMarker([a.lat, a.lon], { radius: 8, color, fillOpacity: 0.8 }).addTo(map).bindPopup(popup));

    const li = document.createElement("li");
    li.className = level;
    const est = a.estimated.length ? ` (est. ${a.estimated.join(", ")})` : "";
    const threat = a.top_threat ? `, main threat: ${a.top_threat}` : "";
    li.textContent = `${a.name} [${a.type}] risk ${a.risk}%${threat}. About ${a.recovery_hrs} h to recover (est.)${est}`;
    $("results").appendChild(li);
  });
  $("summary").textContent = assets.length ? `${count.high} high, ${count.mid} medium, ${count.low} low risk` : "";
}
