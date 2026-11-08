import math
HAZARDS = {
    "wind":      {"label": "Wind speed",          "unit": "mph", "max": 200, "full": 150, "step": 5,   "group": "main", "hint": "Hurricane-force starts at 74 mph."},
    "rain":      {"label": "Rainfall (24 h)",     "unit": "in",  "max": 24,  "full": 10,  "step": 0.5, "group": "main", "hint": "6+ inches in a day can cause flash floods."},
    "flood":     {"label": "Flood / storm surge", "unit": "ft",  "max": 20,  "full": 8,   "step": 0.5, "group": "main", "hint": "Water height above the lowest ground in your area."},
    "ice":       {"label": "Ice buildup",         "unit": "in",  "max": 3,   "full": 1,   "step": 0.1, "group": "more", "hint": "Even half an inch can bring down power lines."},
    "snow":      {"label": "Snowfall",            "unit": "in",  "max": 60,  "full": 30,  "step": 1,   "group": "more", "hint": "Heavy snow loads roofs and slows repair crews."},
    "lightning": {"label": "Lightning",           "unit": "/10", "max": 10,  "full": 10,  "step": 1,   "group": "more", "hint": "Strikes can trip power equipment."},
    "heat":      {"label": "Heat above normal",   "unit": "F",   "max": 40,  "full": 30,  "step": 1,   "group": "more", "hint": "Extra demand strains the power grid."},
    "quake":     {"label": "Earthquake shaking",  "unit": "MMI", "max": 12,  "full": 9,   "step": 1,   "group": "more", "hint": "6 = strong shaking, 8 = heavy damage."},
}
VULN = {
    "substation":   {"wind": .50, "rain": .30, "flood": .90, "ice": 1.0, "snow": .30, "lightning": 1.0,  "heat": .60, "quake": .50},
    "hospital":     {"wind": .25, "rain": .20, "flood": .60, "ice": .30, "snow": .30, "lightning": .20,  "heat": .20, "quake": .45},
    "fire_station": {"wind": .25, "rain": .20, "flood": .60, "ice": .30, "snow": .30, "lightning": .15,  "heat": .10, "quake": .45},
    "police":       {"wind": .25, "rain": .20, "flood": .60, "ice": .30, "snow": .30, "lightning": .15,  "heat": .10, "quake": .45},
    "water_works":  {"wind": .20, "rain": .30, "flood": .90, "ice": .30, "snow": .20, "lightning": .40,  "heat": .15, "quake": .50},
    "bridge":       {"wind": .40, "rain": .30, "flood": 1.0, "ice": .60, "snow": .30, "lightning": .05,  "heat": .20, "quake": .70},
}
CRITICAL = {"substation": 9, "hospital": 10, "fire_station": 8, "police": 7, "water_works": 9, "bridge": 7}
RECOVERY = {"substation": 48, "hospital": 24, "fire_station": 12, "police": 12, "water_works": 60, "bridge": 72}
CARRY = {"hospital": 0.35, "fire_station": 0.5, "police": 0.5, "water_works": 0.6}

WIND_MAT = {"W": 1.15, "M": 0.9, "S": 0.8, "H": 1.6}

def _dist(a, b):
    return math.hypot((a["lon"] - b["lon"]) * math.cos(math.radians(a["lat"])), a["lat"] - b["lat"])

def score_assets(assets, scenario, area=None):
    sev = {k: min(float(scenario.get(k, 0)) / h["full"], 1.5) for k, h in HAZARDS.items()}
    results = []
    for a in assets:
        estimated, height = [], 1.0
        if a["type"] != "bridge":
            levels = a["levels"]
            if levels is None:
                levels = 2
                estimated.append("floors")
            try:
                height = 1 + min(float(levels), 20) * 0.02
            except ValueError:
                height = 1.04
        mat = WIND_MAT.get(a.get("material"), 1.0)
        base = a.get("base_elev") if a.get("base_elev") is not None else (area or {}).get("base_elev")
        survive, chances = 1.0, {}
        for k in HAZARDS: 
            sv = sev[k]
            if k == "flood" and a.get("ground_elv") is not None and base is not None:
                depth = float(scenario.get("flood", 0)) - (a["ground_elv"] - base) - (a.get("found_ht") or 0)
                sv = min(max(depth, 0) / HAZARDS["flood"]["full"], 1.5)
                if str(a.get("firmzone") or "").upper().startswith(("A", "V")): 
                    sv = min(sv * 1.25, 1.5)
            c = min(VULN[a["type"]][k] * sv * (height * mat if k == "wind" else 1), 0.98)
            chances[k] = c
            survive *= 1 - c
        own = round((1 - survive) * 100)
        results.append({**a, "own_risk": own, "risk": own, "estimated": estimated, "depends_on": None, "cascade": 0,
                        "breakdown": {HAZARDS[k]["label"]: round(c * 100) for k, c in chances.items()}})

    subs = [r for r in results if r["type"] == "substation"]
    for r in results:
        if r["type"] in CARRY and subs:
            s = min(subs, key=lambda x: _dist(r, x))
            new = round(100 * (1 - (1 - r["own_risk"] / 100) * (1 - s["own_risk"] / 100 * CARRY[r["type"]])))
            r.update(risk=new, cascade=new - r["own_risk"], depends_on=s["name"])

    for r in results:
        src = r.get("data_source", "")
        m = 5 if "building" in src else 8 if "terrain" in src else 12  # tighter range when we have real data
        if r["estimated"] and m < 12:
            m += 2
        r.update(risk_low=max(0, r["risk"] - m), risk_high=min(100, r["risk"] + m),
                 confidence="high" if "building" in src and not r["estimated"] else "medium" if "NSI" in src else "low",
                 priority=round(r["risk"] * (CRITICAL[r["type"]] + min(r.get("people_nearby", 0) / 300, 3)) / 10),
                 recovery_hrs=round(RECOVERY[r["type"]] * r["risk"] / 100 * 1.5))
    return sorted(results, key=lambda r: r["priority"], reverse=True)