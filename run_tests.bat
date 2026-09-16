@echo off
rem Кожен тест сам піднімає і зупиняє власний сервер, тому окремий start не потрібен
node tests/routes.js
node tests/reliability.js