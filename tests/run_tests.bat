@echo off
cd /d "%~dp0.."
python -m pytest tests/test_batch_nodes.py -v %*
pause
