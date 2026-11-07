import re
import time
import requests
from concurrent.futures import ThreadPoolExecutor
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

session = requests.Session()
session.headers.update({"User-Agent": "StormReadinessMap-Hackathon (student project)"})
retry = Retry(total=2, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504])
session.mount("https://", HTTPAdapter(max_retries=retry))

TIMEOUT = (5, 15)

_cache = {}

def cached(key, ttl_seconds, fetch_function):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl_seconds:
        return hit[1]
    value = fetch_function()
    _cache[key] = (time.time(), value)
    return value

OVERPASS_URLS = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter"]

def get_infrastructure(s, w, n, e):
    key = ("infra", round(s, 3), round(w, 3), round(n, 3), round(e, 3))
    return cached(key, 3600, lambda: _fetch_infrastructure(s, w, n, e))

def _fetch_infrastructure(s, w, n, e):
    query = f"""
    [out:json][timeout:25];
    (
      nwr["amenity"~"hospital|fire_station"]({s},{w},{n},{e});
      nwr["power"="substation"]({s},{w},{n},{e});
      nwr["bridge"="yes"]["highway"]({s},{w},{n},{e});
    );
    out center tags 150;"""
    last_error = None
    for url in OVERPASS_URLS:
        try:
            r = session.post(url, data={"data": query}, timeout=(5, 40))
            r.raise_for_status()
            break
        except requests.RequestException as err:
            last_error = err
    else:
        raise last_error

    assets = []
    for el in r.json().get("elements", []):
        tags = el.get("tags", {})
        center = el.get("center", el)
        if "lat" not in center:
            continue
        if tags.get("power") == "substation":
            kind = "substation"
        elif tags.get("amenity") in ("hospital", "fire_station"):
            kind = tags["amenity"]
        else:
            kind = "bridge"
        assets.append({
            "name": tags.get("name", f"Unnamed {kind}"), "type": kind,
            "lat": center["lat"], "lon": center["lon"],
            "levels": tags.get("building:levels"), "material": tags.get("building:material"),
        })
    return assets

def get_forecast(lat, lon):
    key = ("wx", round(lat, 2), round(lon, 2))
    try:
        return cached(key, 600, lambda: _fetch_forecast(lat, lon))
    except Exception:
        return {"wind_mph": 25, "wind_now": 25, "peak_time": None, "hourly_winds": [],
                "summary": "Forecast unavailable, using a default of 25 mph", "alerts": [], "live": False}

def _wind_number(text):
    return max(int(x) for x in re.findall(r"\d+", text))

def _fetch_alerts(lat, lon):
    r = session.get(f"https://api.weather.gov/alerts/active?point={lat:.4f},{lon:.4f}", timeout=TIMEOUT)
    r.raise_for_status()
    events = [a["properties"]["event"] for a in r.json().get("features", [])]
    return sorted(set(events))

def _fetch_hourly_url(lat, lon):
    r = session.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}", timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["properties"]["forecastHourly"]

def _fetch_forecast(lat, lon):
    with ThreadPoolExecutor(max_workers=2) as pool:
        alerts_job = pool.submit(_fetch_alerts, lat, lon)
        url = cached(("grid", round(lat, 2), round(lon, 2)), 86400, lambda: _fetch_hourly_url(lat, lon))
        hourly = session.get(url, timeout=TIMEOUT)
        hourly.raise_for_status()
        alerts = alerts_job.result()

    periods = hourly.json()["properties"]["periods"][:24]
    winds = [_wind_number(p["windSpeed"]) for p in periods]
    peak_index = winds.index(max(winds))
    return {
        "wind_mph": winds[peak_index],
        "wind_now": winds[0],
        "peak_time": periods[peak_index]["startTime"],
        "hourly_winds": winds,
        "summary": periods[peak_index]["shortForecast"],
        "alerts": alerts,
        "live": True,
    }
