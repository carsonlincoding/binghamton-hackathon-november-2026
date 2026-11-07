HAZARDS = {
    "wind":      {"label": "Wind speed",             "unit": "mph",  "max": 200, "full": 150, "step": 5},
    "rain":      {"label": "Rainfall (24 h)",        "unit": "in",   "max": 24,  "full": 10,  "step": 0.5},
    "flood":     {"label": "Flood / storm surge",    "unit": "ft",   "max": 20,  "full": 8,   "step": 0.5},
    "ice":       {"label": "Ice buildup",            "unit": "in",   "max": 3,   "full": 1,   "step": 0.1},
    "snow":      {"label": "Snowfall",               "unit": "in",   "max": 60,  "full": 30,  "step": 1},
    "lightning": {"label": "Lightning intensity",    "unit": "/10",  "max": 10,  "full": 10,  "step": 1},
}

VULN = {
    "substation":   {"wind": 0.50, "rain": 0.30, "flood": 0.90, "ice": 1.00, "snow": 0.30, "lightning": 1.00},
    "hospital":     {"wind": 0.25, "rain": 0.20, "flood": 0.60, "ice": 0.30, "snow": 0.30, "lightning": 0.20},
    "fire_station": {"wind": 0.25, "rain": 0.20, "flood": 0.60, "ice": 0.30, "snow": 0.30, "lightning": 0.15},
    "bridge":       {"wind": 0.40, "rain": 0.30, "flood": 1.00, "ice": 0.60, "snow": 0.30, "lightning": 0.05},
}
CRITICAL = {"substation": 9, "hospital": 10, "fire_station": 8, "bridge": 7}
RECOVERY = {"substation": 48, "hospital": 24, "fire_station": 12, "bridge": 72}

def score_assets(assets, scenario):
    sev = {k: min(float(scenario.get(k, 0)) / h["full"], 1.5) for k, h in HAZARDS.items()}
    results = []
    for a in assets:
        estimated = []

        levels = a["levels"]
        if levels is None:
            levels = 2
            estimated.append("floors")
        try:
            height_factor = 1 + min(float(levels), 20) * 0.02
        except ValueError:
            height_factor = 1.04

        survive, chances = 1.0, {}
        for k in HAZARDS:
            chance = VULN[a["type"]][k] * sev[k] * (height_factor if k == "wind" else 1)
            chance = min(chance, 0.98)
            chances[k] = chance
            survive *= (1 - chance)

        risk = round((1 - survive) * 100)
        top = max(chances, key=chances.get) if risk > 0 else None
        results.append({
            **a, "risk": risk,
            "priority": round(risk * CRITICAL[a["type"]] / 10),
            "recovery_hrs": round(RECOVERY[a["type"]] * (risk / 100) * 1.5),
            "top_threat": HAZARDS[top]["label"] if top else None,
            "estimated": estimated,
        })
    return sorted(results, key=lambda r: r["priority"], reverse=True)
