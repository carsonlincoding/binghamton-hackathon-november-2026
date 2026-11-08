# app.py - the BACKEND entry point. Run this file to start the server.
# Flow: browser (map.js) -> /api/analyze -> data_fetch.py -> risk_model.py -> JSON back.
import os, sys, threading, webbrowser, time, math

# Let Python find our other files in THIS folder, wherever the program is launched from.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

from flask import Flask, render_template, request, jsonify
from data_fetch import get_infrastructure, get_forecast, get_structures, enrich_assets
from concurrent.futures import ThreadPoolExecutor
from risk_model import score_assets, HAZARDS

app = Flask(__name__,
            template_folder=os.path.join(HERE, "templates"),
            static_folder=os.path.join(HERE, "static"))

PREPARED = {}  # finished areas, kept in memory
JOBS = {}      # areas being downloaded right now, so two requests for one area share a single download
LOCK = threading.Lock()
FETCH = ThreadPoolExecutor(max_workers=4)  # network downloads
BUILD = ThreadPoolExecutor(max_workers=2)  # one build job per area

def snap(box):
    """Round the box OUTWARD to a 0.01 grid. Nearby selections then share the same cached data."""
    s, w, n, e = box
    lo = lambda v: math.floor(round(v * 100, 6)) / 100  # round() avoids tiny floating-point errors
    hi = lambda v: math.ceil(round(v * 100, 6)) / 100
    return lo(s), lo(w), hi(n), hi(e)

def _build(sb, small):
    infra_job = FETCH.submit(get_infrastructure, *sb)  # both downloads run at the same time
    struct_job = FETCH.submit(get_structures, *sb) if small else None
    infra = infra_job.result()
    structs = struct_job.result() if struct_job else []
    assets, area = enrich_assets(infra, structs)
    if not small:
        area["note"] = "Large area: building details are estimated. Zoom in for government building data."
    return assets, area, bool(structs) or not small  # last value False = government lookup failed, do not remember it

def prepare(box):
    """Return (assets inside the box, area info, was_cached)."""
    sb = snap(box)
    small = (sb[2] - sb[0]) <= 0.11 and (sb[3] - sb[1]) <= 0.11
    key = (sb, small)
    with LOCK:
        done = PREPARED.get(key)
        if done is None and key not in JOBS:
            JOBS[key] = BUILD.submit(_build, sb, small)
        job = JOBS.get(key)
    hit = done is not None
    if done is None:
        try:
            assets, area, ok = job.result()  # if someone already started this download, we simply wait for it
        finally:
            with LOCK:
                JOBS.pop(key, None)
        if ok:
            with LOCK:
                if len(PREPARED) >= 8:
                    PREPARED.pop(next(iter(PREPARED)))
                PREPARED[key] = (assets, area)
        done = (assets, area)
    assets, area = done
    s, w, n, e = box
    return [x for x in assets if s <= x["lat"] <= n and w <= x["lon"] <= e], area, hit

def bbox_from(body):
    """Pull the locked area out of the request and reject areas that are too big."""
    s, w, n, e = body["south"], body["west"], body["north"], body["east"]
    if (n - s) > 0.3 or (e - w) > 0.3:
        return None
    return s, w, n, e

@app.route("/")
def home():
    # Passing HAZARDS lets index.html build one slider per storm factor automatically.
    return render_template("index.html", hazards=HAZARDS)

@app.route("/api/live-wind", methods=["POST"])
def live_wind():
    # The "Load live forecast" button: returns real peak wind + alerts for the locked area.
    box = bbox_from(request.get_json())
    if not box:
        return jsonify({"error": "Area too large. Zoom in a bit and try again."}), 400
    s, w, n, e = box
    return jsonify(get_forecast((s + n) / 2, (w + e) / 2))

@app.route("/api/warm", methods=["POST"])
def warm():
    # Called the moment an area is locked, so the data is already downloaded when the user presses Run.
    box = bbox_from(request.get_json())
    if not box:
        return jsonify({"error": "Area too large. Zoom in a bit and try again."}), 400
    try:
        assets, area, hit = prepare(box)
    except Exception:
        return jsonify({"error": "Map data service is busy. You can still press Run to retry."}), 503
    return jsonify({"count": len(assets), "note": area.get("note")})

@app.route("/api/analyze", methods=["POST"])
def analyze():
    body = request.get_json()
    box = bbox_from(body)
    if not box:
        return jsonify({"error": "Area too large. Zoom in a bit and try again."}), 400

    # Keep every slider value between 0 and its allowed max (never trust the browser).
    sent = body.get("scenario", {})
    scenario = {k: max(0.0, min(float(sent.get(k, 0)), h["max"])) for k, h in HAZARDS.items()}

    t0 = time.time()
    try:
        assets, area, hit = prepare(box)
    except Exception:
        return jsonify({"error": "Map data service is busy. Wait a moment and try again."}), 503
    return jsonify({"scenario": scenario, "area": area, "assets": score_assets(assets, scenario, area),
                    "ms": round((time.time() - t0) * 1000), "cached": hit})

if __name__ == "__main__":
    threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:5000")).start()  # auto-open browser
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)