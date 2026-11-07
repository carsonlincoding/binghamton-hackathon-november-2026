#!/bin/bash
cd "$(dirname "$0")"
[ -d venv ] || { echo "Setting up for the first time..."; python3 -m venv venv; }
source venv/bin/activate
pip install -q -r requirements.txt
python app.py
