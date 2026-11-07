import os, sys, threading, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)

from flask import Flask, render_template, request, jsonify
from data_fetch import get_infrastructure, get_forecast
from risk_model import score_assets, HAZARDS

app = Flask(__name__,
            template_folder=os.path.join(HERE, "templates"),
            static_folder=os.path.join(HERE, "static"))

def bbox_from(body):
    s, w, n, e = body["south"], body["west"], body["north"], body["east"]
    if (n - s) > 0.1 or (e - w) > 0.1:
        return None
    return s, w, n, e

@app.route("/")
def home():
    return render_template("index.html", hazards=HAZARDS)

@app.route("/api/live-wind", methods=["POST"])
def live_wind():
    box = bbox_from(request.get_json())
    if not box:
        return jsonify({"error": "Area too large. Pick roughly a town-sized box."}), 400
    s, w, n, e = box
    return jsonify(get_forecast((s + n) / 2, (w + e) / 2))

@app.route("/api/analyze", methods=["POST"])
def analyze():
    body = request.get_json()
    box = bbox_from(body)
    if not box:
        return jsonify({"error": "Area too large. Pick roughly a town-sized box."}), 400

    sent = body.get("scenario", {})
    scenario = {k: max(0.0, min(float(sent.get(k, 0)), h["max"])) for k, h in HAZARDS.items()}

    try:
        assets = get_infrastructure(*box)
    except Exception:
        return jsonify({"error": "Map data service is busy. Wait a moment and try again."}), 503
    return jsonify({"scenario": scenario, "assets": score_assets(assets, scenario)})

if __name__ == "__main__":
    threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:5000")).start()
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)
