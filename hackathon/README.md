# Storm Readiness Map
Pick an area in the US -> see which infrastructure is most at risk in a storm.

## Run it (any laptop)
1. Install Python 3.9+ from python.org (Windows: tick "Add Python to PATH" during install).
2. Download or clone this project and unzip it.
3. Start it:
   - Windows: double-click `run.bat`
   - Mac/Linux: open a terminal in this folder and run `bash run.sh`
4. Your browser opens at http://127.0.0.1:5000 automatically.

The first run installs packages, so it takes a minute. It needs internet for map tiles and data.
The address 127.0.0.1 is private: only your own computer can see it.

## Data
OpenStreetMap (Overpass API) + National Weather Service. No API keys needed.

## Troubleshooting
- "No module named data_fetch": make sure app.py, data_fetch.py and risk_model.py are in the same folder,
  and the file is named with an underscore (data_fetch.py, not "data fetch.py").
- "python not found": reinstall Python and tick "Add Python to PATH".
