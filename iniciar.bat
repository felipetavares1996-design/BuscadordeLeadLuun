@echo off
title iFood Lead Hunter Pro - Servidor
chcp 65001 > nul
cls

echo ===================================================================
echo               iFood Lead Hunter Pro - Grande SP
echo        Prospeccao de Leads Gastronomicos para Consultoria
echo ===================================================================
echo.
echo Iniciando servidor Node.js...
echo.

start http://localhost:3000

node server.js

pause
