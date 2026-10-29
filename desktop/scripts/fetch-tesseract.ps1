# Put a portable Tesseract (UB Mannheim Windows build) + tessdata_best eng/fra
# into desktop/resources/tesseract.
#   powershell -ExecutionPolicy Bypass -File desktop/scripts/fetch-tesseract.ps1
# The installer is run silently into the target folder (it's an NSIS installer:
# /S = silent, /D = destination, must be last and unquoted), then trimmed.
param(
  [string]$Version = "5.4.0.20240606",
  [string]$Out = (Join-Path $PSScriptRoot "..\resources\tesseract")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Out = [System.IO.Path]::GetFullPath($Out)
$tmp = Join-Path $env:RUNNER_TEMP "tesseract-dl"
if (-not $env:RUNNER_TEMP) { $tmp = Join-Path $env:TEMP "tesseract-dl" }
New-Item -ItemType Directory -Force $tmp | Out-Null
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }

$setup = Join-Path $tmp "tesseract-setup.exe"
$url = "https://github.com/UB-Mannheim/tesseract/releases/download/v$Version/tesseract-ocr-w64-setup-$Version.exe"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $setup

Write-Host "Installing into $Out"
$p = Start-Process -FilePath $setup -ArgumentList "/S", "/D=$Out" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Tesseract installer exited with $($p.ExitCode)" }
if (-not (Test-Path (Join-Path $Out "tesseract.exe"))) { throw "tesseract.exe not found in $Out" }

# Trim what OCR doesn't need: Java viewer, docs, uninstaller, bundled models
Get-ChildItem $Out -Filter *.jar | Remove-Item -Force
Get-ChildItem $Out -Filter *.html | Remove-Item -Force
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Out "tesseract-uninstall.exe")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Out "doc")
Get-ChildItem (Join-Path $Out "tessdata") -Filter *.traineddata | Remove-Item -Force

# Same models as the Dockerfile
foreach ($lang in "eng", "fra") {
  $dst = Join-Path $Out "tessdata\$lang.traineddata"
  Write-Host "Downloading tessdata_best $lang"
  Invoke-WebRequest -Uri "https://github.com/tesseract-ocr/tessdata_best/raw/main/$lang.traineddata" -OutFile $dst
}

& (Join-Path $Out "tesseract.exe") --version
& (Join-Path $Out "tesseract.exe") --list-langs
