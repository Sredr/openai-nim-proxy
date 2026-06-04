@echo off
start /B node server.js
timeout /T 3 > nul
node tests/routes.js
taskkill /F /IM node.exe > nul 2>&1