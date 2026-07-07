# trove installer (Windows x64) — downloads the prebuilt binary and adds it to
# the user PATH. No admin, no Node.
#
#   irm https://ontrove.sh/install.ps1 | iex
#
# Windows on ARM is not a Bun compile target; use `bunx @ontrove/cli` there.

$ErrorActionPreference = 'Stop'

$Repo = 'hollyburnanalytics/trove-packages'
$Version = if ($env:TROVE_VERSION) { $env:TROVE_VERSION } else { 'latest' }
$InstallDir = if ($env:TROVE_INSTALL_DIR) { $env:TROVE_INSTALL_DIR } else { "$env:LOCALAPPDATA\trove\bin" }

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Error 'Windows on ARM has no native trove binary. Use: bunx @ontrove/cli'
}

$asset = 'trove-windows-x64.zip'
$base = if ($Version -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$Version"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmp = New-TemporaryFile
Write-Host "Downloading trove (windows-x64, $Version)…"
Invoke-WebRequest -Uri "$base/$asset" -OutFile $tmp

# Verify the checksum before extracting (fail closed).
$sumsFile = New-TemporaryFile
Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsFile
$sums = Get-Content $sumsFile
$expectedLine = $sums | Where-Object { $_ -match "[ /]$([regex]::Escape($asset))$" } | Select-Object -First 1
if (-not $expectedLine) { Write-Error "No checksum listed for $asset in SHA256SUMS" }
$expected = ($expectedLine -split '\s+')[0].ToLower()
$actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { Write-Error "Checksum verification failed for $asset (expected $expected, got $actual)" }
Remove-Item $sumsFile
Write-Host "Checksum OK."

Expand-Archive -Path $tmp -DestinationPath $InstallDir -Force
Remove-Item $tmp
Write-Host "Installed trove to $InstallDir\trove-windows-x64.exe"
# Normalize the binary name to `trove.exe`.
Move-Item -Force "$InstallDir\trove-windows-x64.exe" "$InstallDir\trove.exe"

# Add to the user PATH (persists for future processes; the current one needs a restart).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
  Write-Host "Added $InstallDir to your PATH. Restart your terminal to use 'trove'."
} else {
  Write-Host "trove is ready. Run: trove --version"
}
