# Put a portable Tesseract (UB Mannheim Windows build) + tessdata_best eng/fra
# into desktop/resources/tesseract.
#   powershell -ExecutionPolicy Bypass -File desktop/scripts/fetch-tesseract.ps1
# The UB Mannheim installer is an NSIS archive: it is unpacked with 7-Zip (no
# install, no admin rights), then trimmed to what OCR needs. 7-Zip is used
# from PATH / Program Files (GitHub's Windows runners have it), otherwise a
# portable copy is downloaded.
param(
  [string]$Version = "5.4.0.20240606",
  [string]$Out = (Join-Path $PSScriptRoot "..\resources\tesseract")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Out = [System.IO.Path]::GetFullPath($Out)
$tmp = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP "tesseract-dl" } else { Join-Path $env:TEMP "tesseract-dl" }
New-Item -ItemType Directory -Force $tmp | Out-Null
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }

function Get-SevenZip {
  $cmd = Get-Command 7z -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $pf = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
  if (Test-Path $pf) { return $pf }
  # portable: 7zr.exe (7z format only) unpacks the full 7-Zip, which reads NSIS
  $dir = Join-Path $tmp "7zip"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile (Join-Path $dir "7zr.exe")
  Invoke-WebRequest -Uri "https://www.7-zip.org/a/7z2409-x64.exe" -OutFile (Join-Path $dir "7z-setup.exe")
  & (Join-Path $dir "7zr.exe") x -y "-o$dir\full" (Join-Path $dir "7z-setup.exe") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not unpack 7-Zip" }
  return (Join-Path $dir "full\7z.exe")
}

$setup = Join-Path $tmp "tesseract-setup.exe"
$url = "https://github.com/UB-Mannheim/tesseract/releases/download/v$Version/tesseract-ocr-w64-setup-$Version.exe"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $setup

$7z = Get-SevenZip
Write-Host "Unpacking with $7z into $Out"
& $7z x -y "-o$Out" $setup | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7-Zip exited with $LASTEXITCODE" }
if (-not (Test-Path (Join-Path $Out "tesseract.exe"))) { throw "tesseract.exe not found in $Out" }

# Trim what OCR doesn't need: installer internals, Java viewer, docs, bundled models
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Out '$PLUGINSDIR')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Out "doc")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Out "tesseract-uninstall.exe")
Get-ChildItem $Out -Filter *.html | Remove-Item -Force
# training tools (lstmtraining, text2image, ...): separate exes, not used by tesseract.exe
Get-ChildItem $Out -Filter *.exe | Where-Object { $_.Name -ne "tesseract.exe" } | Remove-Item -Force
$tessdata = Join-Path $Out "tessdata"
New-Item -ItemType Directory -Force $tessdata | Out-Null
Get-ChildItem $Out -Recurse -Filter *.jar | Remove-Item -Force
Get-ChildItem $tessdata -Filter *.traineddata | Remove-Item -Force

# Same models as the Dockerfile
foreach ($lang in "eng", "fra") {
  Write-Host "Downloading tessdata_best $lang"
  Invoke-WebRequest -Uri "https://github.com/tesseract-ocr/tessdata_best/raw/main/$lang.traineddata" -OutFile (Join-Path $tessdata "$lang.traineddata")
}

$env:TESSDATA_PREFIX = $tessdata
& (Join-Path $Out "tesseract.exe") --version
if ($LASTEXITCODE -ne 0) { throw "tesseract.exe does not run" }
$langs = (& (Join-Path $Out "tesseract.exe") --list-langs 2>&1) -join " "
Write-Host $langs
if ($langs -notmatch "eng" -or $langs -notmatch "fra") { throw "eng/fra models missing: $langs" }
exit 0
