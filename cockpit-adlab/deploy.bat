@echo off
REM deploy.bat - a thin wrapper, and nothing else.
REM
REM It exists so an operator can double-click, and it contains no logic:
REM logic in two languages is logic that diverges. Everything it could say,
REM deploy.ps1 says.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
exit /b %ERRORLEVEL%
