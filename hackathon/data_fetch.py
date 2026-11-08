# data_fetch.py - gets REAL data from free public sources. Used by app.py.
# Upgrades over version 1:
#   1. CACHING: repeat requests (like moving the wind slider) reuse saved answers instead of re-downloading.
#   2. PARALLEL: the alerts request runs at the same time as the forecast request.
#   3. RETRIES: the free weather service sometimes errors; we quietly try again.
#   4. WORST CASE: wind is the PEAK of the next 24 hours, not just the next hour.
import math
import re
import time
import requests
from concurrent.futures import ThreadPoolExecutor
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# One shared "session" reuses the same connection, which is faster than a new one every time.
session = requests.Session()
session.headers.update({"User-Agent": "StormReadinessMap-Hackathon (student project)"})  # NWS requires this
retry = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
session.mount("https://", HTTPAdapter(max_retries=retry))

TIMEOUT = (5, 15)  # seconds to connect, seconds to wait for data

# ---------- Tiny cache: remembers answers for a while ----------
_cache = {}  # key -> (time saved, value)

def cached(key, ttl_seconds, fetch_function):
    """If we saved this answer recently, return it. Otherwise fetch, save, and return it."""
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl_seconds:
        return hit[1]
    value = fetch_function()
    _cache[key] = (time.time(), value)
    return value

# ---------- Infrastructure (OpenStreetMap) ----------
# Two public servers: if the first is busy, we try the second.
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"]

def get_infrastructure(s, w, n, e):
    # Round the box so tiny differences still hit the cache. Infrastructure rarely changes: keep 1 hour.
    key = ("infra", round(s, 3), round(w, 3), round(n, 3), round(e, 3))
    return cached(key, 3600, lambda: _fetch_infrastructure(s, w, n, e))

def _fetch_infrastructure(s, w, n, e):
    big = max(n - s, e - w) > 0.3  # very large area: keep only major bridges so the answer stays manageable
    box = f"({s},{w},{n},{e})"
    bridges = '["highway"~"motorway|trunk|primary"]' if big else '["highway"]'
    # One limit PER TYPE, so thousands of small bridges can never push out the hospitals and substations.
    query = f"""[out:json][timeout:{90 if big else 50}];
    nwr["amenity"="hospital"]{box}->.a; .a out center tags 400;
    nwr["amenity"~"fire_station|police"]{box}->.b; .b out center tags 400;
    nwr["man_made"="water_works"]{box}->.c; .c out center tags 200;
    nwr["power"="substation"]{box}->.d; .d out center tags 600;
    nwr["bridge"="yes"]{bridges}{box}->.e; .e out center tags 500;"""
    last_error = None
    for url in OVERPASS_URLS:
        try:
            r = session.post(url, data={"data": query}, timeout=(5, 100))
            r.raise_for_status()
            break
        except requests.RequestException as err:
            last_error = err
    else:
        raise last_error  # both servers failed

    assets = []
    for el in r.json().get("elements", []):
        tags = el.get("tags", {})
        center = el.get("center", el)  # ways have "center", nodes have lat/lon directly
        if "lat" not in center:
            continue
        if tags.get("power") == "substation":
            kind = "substation"
        elif tags.get("amenity") in ("hospital", "fire_station", "police"):
            kind = tags["amenity"]
        elif tags.get("man_made") == "water_works":
            kind = "water_works"
        else:
            kind = "bridge"
        assets.append({
            "name": tags.get("name", f"Unnamed {kind}"), "type": kind,
            "lat": center["lat"], "lon": center["lon"],
            # Floors/material are often missing in OSM. None = we will ESTIMATE later.
            "levels": tags.get("building:levels"), "material": tags.get("building:material"),
        })
    return assets

# ---------- Weather (National Weather Service) ----------
def get_forecast(lat, lon):
    """Returns the worst wind in the next 24 hours plus active alerts. Never crashes the app."""
    key = ("wx", round(lat, 2), round(lon, 2))  # ~1 km resolution is plenty for weather
    try:
        return cached(key, 600, lambda: _fetch_forecast(lat, lon))  # keep 10 minutes
    except Exception:
        # Weather service down: return a clearly-labeled default. Not cached, so we retry next time.
        return {"wind_mph": 25, "wind_now": 25, "peak_time": None, "hourly_winds": [],
                "summary": "Forecast unavailable, using a default of 25 mph", "alerts": [], "live": False}

def _wind_number(text):
    """'10 to 20 mph' -> 20.  '15 mph' -> 15."""
    return max(int(x) for x in re.findall(r"\d+", text))

def _fetch_alerts(lat, lon):
    r = session.get(f"https://api.weather.gov/alerts/active?point={lat:.4f},{lon:.4f}", timeout=TIMEOUT)
    r.raise_for_status()
    events = [a["properties"]["event"] for a in r.json().get("features", [])]
    return sorted(set(events))  # remove duplicates

def _fetch_hourly_url(lat, lon):
    r = session.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["properties"]["forecastHourly"]

def _fetch_forecast(lat, lon):
    with ThreadPoolExecutor(max_workers=2) as pool:
        alerts_job = pool.submit(_fetch_alerts, lat, lon)  # runs in the background...
        # ...while we look up the forecast. The grid URL for a place never changes, so cache it a day.
        url = cached(("grid", round(lat, 2), round(lon, 2)), 86400, lambda: _fetch_hourly_url(lat, lon))
        hourly = session.get(url, timeout=TIMEOUT)
        hourly.raise_for_status()
        alerts = alerts_job.result()

    periods = hourly.json()["properties"]["periods"][:24]  # next 24 hours
    winds = [_wind_number(p["windSpeed"]) for p in periods]
    peak_index = winds.index(max(winds))
    return {
        "wind_mph": winds[peak_index],           # the number the risk model uses (worst case)
        "wind_now": winds[0],
        "peak_time": periods[peak_index]["startTime"],
        "hourly_winds": winds,                   # handy later for a wind chart
        "summary": periods[peak_index]["shortForecast"],
        "alerts": alerts,
        "live": True,
    }

# ---------- Government building data: USACE National Structure Inventory (NSI) ----------
NSI_URL = "https://nsi.sec.usace.army.mil/nsiapi/structures?fmt=fc"
BUILDINGS = ("hospital", "fire_station", "police", "water_works")
CELL = 0.004  # about 400 m; we search nearby structures using a simple grid of cells this size

def get_structures(s, w, n, e):
    key = ("nsi", round(s, 3), round(w, 3), round(n, 3), round(e, 3))
    try:
        return cached(key, 3600, lambda: _fetch_structures(s, w, n, e))
    except Exception:
        return []  # if the government service is down, the app keeps working with estimates

def _fetch_structures(s, w, n, e):
    poly = {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}
    body = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": poly}]}
    r = session.post(NSI_URL, json=body, timeout=(5, 45))
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        x, y = p.get("x"), p.get("y")
        if x is None or y is None:
            c = (f.get("geometry") or {}).get("coordinates") or []
            if len(c) < 2:
                continue
            x, y = c[0], c[1]
        t = str(p.get("bldgtype") or "").strip().upper()
        out.append({"lat": y, "lon": x, "material": "H" if t.startswith(("H", "MAN")) else t[:1],
                    "stories": p.get("num_story"), "found_ht": p.get("found_ht"),
                    "elev": p.get("ground_elv"), "firmzone": p.get("firmzone"),
                    "people": (p.get("pop2pmu65") or 0) + (p.get("pop2pmo65") or 0)})
    return out

def enrich_assets(assets, structures):
    """Copy material, floors, elevation, flood zone, and nearby population from NSI onto our assets."""
    area = {"structures": len(structures), "people": sum(x["people"] for x in structures),
            "base_elev": None, "source": "USACE National Structure Inventory" if structures else None}
    elevs = sorted(x["elev"] for x in structures if x["elev"] is not None)
    if elevs:
        area["base_elev"] = elevs[int(len(elevs) * 0.05)]  # near the lowest ground in the area
    grid = {}
    for x in structures:
        grid.setdefault((int(x["lat"] // CELL), int(x["lon"] // CELL)), []).append(x)
    for a in assets:
        ci, cj = int(a["lat"] // CELL), int(a["lon"] // CELL)
        cand = [x for di in (-1, 0, 1) for dj in (-1, 0, 1) for x in grid.get((ci + di, cj + dj), [])]
        cos = math.cos(math.radians(a["lat"]))
        d = lambda x: math.hypot(x["lat"] - a["lat"], (x["lon"] - a["lon"]) * cos)
        near = min(cand, key=d, default=None)
        local = sorted(x["elev"] for di in range(-2, 3) for dj in range(-2, 3)
                       for x in grid.get((ci + di, cj + dj), []) if x["elev"] is not None)
        a["base_elev"] = local[int(len(local) * 0.1)] if len(local) >= 5 else None  # low ground within ~1 km
        a["people_nearby"] = round(sum(x["people"] for x in cand if d(x) <= CELL))
        a["data_source"] = "OpenStreetMap"
        if near and d(near) <= CELL:
            a.update(ground_elv=near["elev"], firmzone=near["firmzone"], data_source="OSM + NSI terrain")
            if a["type"] in BUILDINGS and d(near) <= 0.0006:  # within ~60 m: treat as the same building
                a.update(material=near["material"] or a["material"], levels=near["stories"] or a["levels"],
                         found_ht=near["found_ht"], data_source="OSM + NSI building")
    return assets, area