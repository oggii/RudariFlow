# RudariFlow - sherpa-onnx runtime for speaker separation (Files tab)
#
# Run once after cloning the repo (and after changing the pinned version):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1
#
# Downloads the pinned sherpa-onnx Windows shared build (without TTS), checks
# its SHA-256 and unpacks its lib folder to src-tauri\binaries\sherpa-onnx.
# The build links against its import library (SHERPA_LIB_PATH in
# src-tauri\.cargo\config.toml). The installer ships sherpa-onnx-c-api.dll
# and onnxruntime.dll next to rudariflow.exe, which delay-loads them: a
# missing DLL only turns speaker separation off. The static build is not
# used: it links the static C runtime, which clashes with the rest of the app.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Version = "v1.12.9"
$Name = "sherpa-onnx-$Version-win-x64-shared-no-tts"
$Archive = "$Name.tar.bz2"
$Sha256 = "ddd697771ffbf8db35bda6232b898f0c7778db9ac39ed01cd800f79af5d7180a"
$Url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$Version/$Archive"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\sherpa-onnx"
$Work = Join-Path ([IO.Path]::GetTempPath()) "rudariflow-$Name"

function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

New-Item -ItemType Directory -Path $Work -Force | Out-Null
$path = Join-Path $Work $Archive
if (-not (Test-Path $path) -or (Get-Sha256 $path) -ne $Sha256) {
    Write-Host "Downloading $Archive ..."
    Invoke-WebRequest -Uri $Url -OutFile $path -UseBasicParsing
}
$hash = Get-Sha256 $path
if ($hash -ne $Sha256) { throw "SHA-256 mismatch for ${Archive}: got $hash, expected $Sha256" }

$unpacked = Join-Path $Work "unpacked"
if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
# Windows' own tar (bsdtar) reads .tar.bz2.
& "$env:SystemRoot\System32\tar.exe" -xjf $path -C $unpacked
if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Archive" }

# Emptied rather than deleted: a shell or Explorer in the folder would block it.
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Get-ChildItem -Path $DestDir | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $unpacked "$Name\lib") -Destination $DestDir -Recurse
$megabytes = (Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("sherpa-onnx {0} ready in {1} ({2:N0} MB)" -f $Version, $DestDir, $megabytes) -ForegroundColor Green
