# LarpCode CLI installer for Windows.
#
# Install or update only the command-line interface (no desktop app):
#   irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1 | iex
#
# Install a specific release:
#   & ([scriptblock]::Create((irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1))) -Version 1.0.1
#
# Install a local build:
#   .\install-cli.ps1 -Binary .\packages\cli\dist-cli\cli-windows-x64\bin\opencode.exe
#
# Remove the CLI:
#   & ([scriptblock]::Create((irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1))) -Uninstall
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Binary,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repository = "Tazmyan/LarpCode"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$installRoot = Join-Path $localAppData "Programs\LarpCode CLI"
$binDir = Join-Path $installRoot "bin"
$executable = Join-Path $binDir "larpcode.exe"
$shim = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".local\bin\larpcode.cmd"

function Get-UserPath {
  $value = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($value) { return $value }
  return ""
}

function Remove-FromUserPath {
  $entries = @((Get-UserPath) -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -ine $binDir.TrimEnd("\") })
  [Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

function Add-ToUserPath {
  $entries = @((Get-UserPath) -split ";" | Where-Object { $_ })
  if ($entries | Where-Object { $_.TrimEnd("\") -ieq $binDir.TrimEnd("\") }) { return }
  [Environment]::SetEnvironmentVariable("Path", (@($entries) + $binDir) -join ";", "User")
}

if ($Uninstall) {
  $running = @()
  try { $running = @(Get-CimInstance Win32_Process -Filter "Name = 'larpcode.exe'" -ErrorAction Stop) } catch {}
  $running | Where-Object { $_.CommandLine -match "serve --service" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($running.Count) { Start-Sleep -Milliseconds 750 }
  $remaining = @()
  try { $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'larpcode.exe'" -ErrorAction Stop) } catch {}
  if ($remaining.Count) {
    throw "Close every LarpCode window and terminal, then run the uninstall again."
  }
  if (Test-Path -LiteralPath $executable) {
    try {
      Remove-Item -LiteralPath $executable -Force -ErrorAction Stop
    } catch {
      throw "Close every LarpCode window and terminal, then run the uninstall again."
    }
  }
  Remove-FromUserPath
  if (Test-Path -LiteralPath $shim) {
    $shimText = Get-Content -LiteralPath $shim -Raw -ErrorAction SilentlyContinue
    if ($shimText -match "larpcode\.exe") { Remove-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host ""
  Write-Host "LarpCode CLI removed from this account." -ForegroundColor Green
  Write-Host "Open a new terminal for the PATH change to take effect."
  return
}

$manifest = $null
$asset = $null
$localVersion = $null
if ($Binary) {
  $source = (Resolve-Path -LiteralPath $Binary -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "The local build was not found at $source."
  }
} else {
  $manifestUrl = if ($Version) {
    "https://github.com/$repository/releases/download/v$($Version.TrimStart('v'))/cli.json"
  } else {
    "https://github.com/$repository/releases/latest/download/cli.json"
  }

  Write-Host "Fetching LarpCode CLI release information..." -ForegroundColor Cyan
  $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -Headers @{ "User-Agent" = "LarpCode-CLI-Installer" }

  $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $platform = switch ($architecture.ToLowerInvariant()) {
    "amd64" { "win32-x64" }
    "arm64" { "win32-arm64" }
    default { throw "Unsupported Windows architecture: $architecture. LarpCode CLI currently supports 64-bit Windows." }
  }

  $property = $manifest.assets.PSObject.Properties[$platform]
  if (-not $property) {
    throw "LarpCode $($manifest.version) has no CLI download for $platform."
  }
  $asset = $property.Value
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("larpcode-cli-" + [Guid]::NewGuid().ToString("N") + ".exe")
try {
  if ($Binary) {
    Write-Host "Installing LarpCode CLI from a local build..." -ForegroundColor Cyan
    Copy-Item -LiteralPath $source -Destination $temporary -Force
    $probe = @(& $temporary --version 2>&1)
    $probeExit = $LASTEXITCODE
    $localVersion = $probe | Select-Object -First 1
    if ($probeExit -ne 0 -or -not $localVersion) {
      throw "The local build did not run. Rebuild it with 'bun run build' and try again."
    }
  } else {
    Write-Host "Downloading LarpCode $($manifest.version) CLI..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $asset.url -OutFile $temporary -UseBasicParsing
    $actual = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $asset.sha256.ToLowerInvariant()) {
      throw "The downloaded CLI did not match the published checksum. Download the release again."
    }
  }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  if (Test-Path -LiteralPath $executable) {
    $backup = "$executable.old-$PID"
    try {
      Move-Item -LiteralPath $executable -Destination $backup -Force
    } catch {
      throw "Close every LarpCode window and terminal, then run this installer again."
    }
    try {
      Move-Item -LiteralPath $temporary -Destination $executable -Force
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } catch {
      if (Test-Path -LiteralPath $backup) {
        Move-Item -LiteralPath $backup -Destination $executable -Force -ErrorAction SilentlyContinue
      }
      throw
    }
  } else {
    Move-Item -LiteralPath $temporary -Destination $executable -Force
  }
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

Add-ToUserPath
$env:Path = "$binDir;$env:Path"

Write-Host ""
if ($Binary) {
  Write-Host "$localVersion (local build) installed." -ForegroundColor Green
} else {
  Write-Host "LarpCode $($manifest.version) CLI installed." -ForegroundColor Green
}
Write-Host "  $executable"
Write-Host ""
Write-Host "Open a new terminal, then run:"
Write-Host "  larpcode --help"
Write-Host ""
Write-Host "The CLI checks this release feed for updates. Run 'larpcode upgrade' to install them."
