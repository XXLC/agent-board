@echo off
rem Lệnh agent-board start|stop|restart|status (cần node trong PATH).
node "%~dp0agent-board.mjs" %*
exit /b %ERRORLEVEL%
