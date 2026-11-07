@echo off
cd /d "%~dp0"
if not exist venv (
    echo Setting up for the first time...
    python -m venv venv
)
call venv\Scripts\activate
pip install -q -r requirements.txt
python app.py
pause
