@echo off
title SQA Agent
cd /d "C:\Users\user\Desktop\Ai Cohort Hackathon Project-ii\sqa-agent"

echo ================================================
echo   SQA Agent - starting dashboard...
echo   Open:  http://localhost:8080
echo   Keep this window open while testing.
echo   Close this window to stop the agent.
echo ================================================
echo.

rem Open the dashboard in the default browser 2s later,
rem giving the server time to boot first.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8080"

call npm run start:dashboard

echo.
echo The dashboard has stopped. If that was unexpected,
echo read the error message above.
pause
