# RudariFlow - whisper-rs-sys with RudariFlow's whisper.cpp patches
#
# Run once after cloning the repo (and after changing the whisper-rs-sys
# version or a patch), before the first cargo build:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-patch.ps1
#
# Unpacks the pinned whisper-rs-sys crate (SHA-256 as in Cargo.lock) to
# src-tauri\vendor\whisper-rs-sys and applies patches\whisper-rs-sys\*.patch.
# Cargo.toml points [patch.crates-io] at that folder. The first build after
# this compiles whisper.cpp again.
#
# 0001: with language "auto", the encoder ran twice on the first window
#       (once for the language detection); now once.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Version = "0.15.0"
$Sha256 = "6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f"
$Crate = "whisper-rs-sys-$Version.crate"
$Url = "https://static.crates.io/crates/whisper-rs-sys/$Crate"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\vendor\whisper-rs-sys"
$PatchDir = Join-Path $RepoRoot "patches\whisper-rs-sys"
$Work = Join-Path ([IO.Path]::GetTempPath()) "rudariflow-whisper-rs-sys-$Version"

function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

New-Item -ItemType Directory -Path $Work -Force | Out-Null
$cratePath = Join-Path $Work $Crate

# Cargo's download cache has the crate after any earlier build.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $HOME ".cargo" }
$cached = Get-ChildItem -Path (Join-Path $cargoHome "registry\cache") -Filter $Crate -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not (Test-Path $cratePath) -and $cached) {
    Copy-Item -Path $cached.FullName -Destination $cratePath
}
if (-not (Test-Path $cratePath) -or (Get-Sha256 $cratePath) -ne $Sha256) {
    Write-Host "Downloading $Crate ..."
    Invoke-WebRequest -Uri $Url -OutFile $cratePath -UseBasicParsing
}
$hash = Get-Sha256 $cratePath
if ($hash -ne $Sha256) {
    throw "SHA-256 mismatch for ${Crate}: got $hash, expected $Sha256"
}

$unpacked = Join-Path $Work "unpacked"
if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
tar -xzf $cratePath -C $unpacked
if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Crate" }

if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
New-Item -ItemType Directory -Path (Split-Path -Parent $DestDir) -Force | Out-Null
Move-Item -Path (Join-Path $unpacked "whisper-rs-sys-$Version") -Destination $DestDir

$relative = "src-tauri/vendor/whisper-rs-sys"
foreach ($patch in Get-ChildItem -Path $PatchDir -Filter "*.patch" | Sort-Object Name) {
    git -C $RepoRoot apply --directory=$relative $patch.FullName
    if ($LASTEXITCODE -ne 0) { throw "Patch $($patch.Name) does not apply" }
    Write-Host "Applied $($patch.Name)"
}

Write-Host "whisper-rs-sys $Version with RudariFlow patches ready in $DestDir" -ForegroundColor Green
