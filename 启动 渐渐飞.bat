@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
set "PY="

rem 1) 本机 Workbuddy / Miniconda / 官方安装目录（不依赖 PATH）
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
  if not defined PY if exist "%%~D\python.exe" call :try "%%~D\python.exe"
)
if not defined PY call :try "%USERPROFILE%\miniconda3\python.exe"
if not defined PY call :try "%USERPROFILE%\anaconda3\python.exe"
if not defined PY call :try "%LocalAppData%\Programs\Python\Python313\python.exe"
if not defined PY call :try "%LocalAppData%\Programs\Python\Python312\python.exe"
if not defined PY call :try "%LocalAppData%\Programs\Python\Python311\python.exe"

rem 2) py 启动器
if not defined PY (
  py -3 -c "import sys, sqlite3; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)

rem 3) PATH 上的 python，跳过微软商店占位程序
if not defined PY (
  for /f "delims=" %%I in ('where python 2^>nul') do (
    if not defined PY (
      echo %%~I | find /i "\WindowsApps\" >nul
      if errorlevel 1 call :try "%%~I"
    )
  )
)

if not defined PY (
  echo.
  echo   找不到可用的 Python 3.10 或更新版本。
  echo   请安装 Python 并勾选 Add python.exe to PATH，
  echo   或把 python.exe 放到本机已有的 Workbuddy / Miniconda 目录。
  echo.
  pause
  exit /b 1
)

echo.
echo   JianJianFei is starting...
echo   Python: %PY%
echo   The actual server address will be printed below.
echo   Close this window to stop the server.
echo.

if /i "%PY%"=="py -3" (
  py -3 -u server.py %*
) else (
  "%PY%" -u server.py %*
)
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo   启动失败，退出码 %ERR%。请把上面的报错发出来。
  echo.
)
pause
exit /b %ERR%

:try
if not exist "%~1" goto :eof
"%~1" -c "import sys, sqlite3; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof
