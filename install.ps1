# install.ps1 - One-line installer for token-optimizer (Windows)
#
# Usage: irm https://raw.githubusercontent.com/edisonaugusthy/token-optimizer/main/install.ps1 | iex
#
# Arguments:
#   -ResetStats   Reset cumulative token savings statistics
#   -Uninstall    Remove token-optimizer from system
#   -Help         Show help message
#
# Environment:
#   TO_DOWNLOAD_URL  Override download URL for testing

param(
    [switch]$ResetStats,
    [switch]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# TLS 1.2+ enforcement (GitHub requires this)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# Configuration
$Repo = "edisonaugusthy/token-optimizer"
$ConfigDir = "$env:USERPROFILE\.config\token-optimizer"
$BaseUrl = if ($env:TO_DOWNLOAD_URL) { $env:TO_DOWNLOAD_URL } else { "https://unpkg.com/token-optimizer@latest/dist" }

function Write-Success { Write-Host $args -ForegroundColor Green }
function Write-Info { Write-Host $args -ForegroundColor Cyan }
function Write-Warn { Write-Host $args -ForegroundColor Yellow }
function Write-Err { Write-Host $args -ForegroundColor Red }

function Show-Help {
    Write-Host "token-optimizer installer (Windows)"
    Write-Host ""
    Write-Host "Usage: install.ps1 [-ResetStats] [-Uninstall] [-Help]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -ResetStats   Reset cumulative token savings statistics"
    Write-Host "  -Uninstall    Remove token-optimizer from system"
    Write-Host "  -Help         Show this help message"
    Write-Host ""
    Write-Host "Environment Variables:"
    Write-Host "  TO_DOWNLOAD_URL  Override download URL for testing"
    exit 0
}

function Remove-FromPath {
    param([string]$PathToRemove)
    
    $UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($UserPath -like "*$PathToRemove*") {
        $NewPath = ($UserPath -split ';' | Where-Object { $_ -ne $PathToRemove }) -join ';'
        [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
        Write-Info "Removed from PATH: $PathToRemove"
    }
}

# Add token-optimizer section to AGENTS.md
function Add-TokenOptimizerSection {
    param([string]$File)
    
    $Content = @"

<!-- token-optimizer start -->

## Token Optimization (token-optimizer)

Always route shell commands through the token filter:

``````bash
node ~/.config/token-optimizer/filter.js <command> [args...]
``````

Applies to git, tests, builds, package managers, search/listing commands, Docker/Kubernetes, and any other shell command. The filter preserves exit codes and falls back to raw output on errors. Request raw/full/verbose output when exact logs are required.

Keep agent replies concise:

- Do not narrate tool choice, MCP usage, or step-by-step thinking.
- Progress updates should be one short sentence only when useful.
- Final replies should include only the result, changed files, and verification.
- Prefer terse bullets over paragraphs; avoid restating the user's request.

<!-- token-optimizer end -->
"@
    
    Add-Content -Path $File -Value $Content
}

# Update token-optimizer section in AGENTS.md
function Update-TokenOptimizerSection {
    param([string]$File)
    
    $Content = Get-Content $File -Raw -ErrorAction SilentlyContinue
    
    if ($Content) {
        # Remove old token-optimizer section if exists
        if ($Content -match "<!-- token-optimizer start -->") {
            $Pattern = "(?s)<!-- token-optimizer start -->.*?<!-- token-optimizer end -->"
            $Content = $Content -replace $Pattern, ""
            Set-Content -Path $File -Value $Content.TrimEnd() -NoNewline
        }
    }
    
    # Add new section
    Add-TokenOptimizerSection $File
}


function Uninstall-TokenOptimizer {
    Write-Info "Uninstalling token-optimizer..."
    
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
        Write-Success "Removed installation directory"
    }
    
    Remove-FromPath $InstallDir
    
    if (Test-Path $ConfigDir) {
        Write-Warn "Config directory preserved: $ConfigDir"
        Write-Warn "Run with -ResetStats to clear statistics"
    }
    
    Write-Success "Uninstall complete"
    exit 0
}

function Reset-Statistics {
    Write-Info "Resetting token statistics..."
    
    $StatsFile = Join-Path $ConfigDir "stats.json"
    if (Test-Path $StatsFile) {
        Remove-Item -Force $StatsFile -ErrorAction SilentlyContinue
        Write-Success "Statistics reset"
    } else {
        Write-Info "No statistics file found"
    }
    exit 0
}

function Test-AgentConfigs {
    $Agents = @(
        @{ Name = "OpenCode"; Path = "$env:USERPROFILE\.config\opencode\AGENTS.md" }
        @{ Name = "Cursor"; Path = "$env:USERPROFILE\.cursor\AGENTS.md" }
        @{ Name = "Claude Desktop"; Path = "$env:APPDATA\Claude\AGENTS.md" }
        @{ Name = "Windsurf"; Path = "$env:USERPROFILE\.windsurf\AGENTS.md" }
    )
    
    Write-Info "Detected AI agents:"
    foreach ($Agent in $Agents) {
        if (Test-Path $Agent.Path) {
            Write-Host "  [Found] $($Agent.Name)" -ForegroundColor Green
        } else {
            Write-Host "  [Not found] $($Agent.Name)" -ForegroundColor DarkGray
        }
    }
}

function Install-TokenOptimizer {
    # Security check for non-HTTPS URLs
    if (-not $BaseUrl.StartsWith("https://") -and 
        -not $BaseUrl.StartsWith("http://localhost") -and 
        -not $BaseUrl.StartsWith("http://127.0.0.1")) {
        Write-Err "Security error: Refusing non-HTTPS download URL"
        Write-Err "  URL: $BaseUrl"
        exit 1
    }
    
    Write-Info "token-optimizer installer (Windows)"
    Write-Host ""
    
    # Check Node.js
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Err "Node.js is required but not found."
        Write-Host "Install Node.js from https://nodejs.org" -ForegroundColor White
        exit 1
    }
    
    $NodeVersion = (node --version).TrimStart('v')
    Write-Success "Node.js $NodeVersion detected"
    
    # Create config directory
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Write-Success "Created config directory: $ConfigDir"
    
    # Download filter.js
    $FilterUrl = "$BaseUrl/scripts/filter.js"
    $FilterDest = Join-Path $ConfigDir "filter.js"
    
    Write-Info "Downloading filter.js..."
    try {
        Invoke-WebRequest -Uri $FilterUrl -OutFile $FilterDest -UseBasicParsing
        Write-Success "Downloaded filter.js"
    } catch {
        Write-Err "Failed to download filter.js: $_"
        exit 1
    }
    
    # Verify filter.js works
    Write-Info "Verifying installation..."
    try {
        $TestResult = & node $FilterDest --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Verification returned non-zero exit code"
        } else {
            Write-Success "filter.js verified successfully"
        }
    } catch {
        Write-Warn "Could not verify filter.js (non-fatal)"
    }
    
    $CommandShim = Join-Path $ConfigDir "token-optimizer.cmd"
    @"
@echo off
set "FILTER=%USERPROFILE%\.config\token-optimizer\filter.js"
if "%~1"=="" goto status
if /I "%~1"=="status" goto status
if /I "%~1"=="stats" (
  node "%FILTER%" stats
  exit /b %ERRORLEVEL%
)
if /I "%~1"=="reset-stats" (
  node "%FILTER%" reset-stats
  exit /b %ERRORLEVEL%
)
if /I "%~1"=="run" (
  shift
  node "%FILTER%" %*
  exit /b %ERRORLEVEL%
)
if /I "%~1"=="filter" (
  shift
  node "%FILTER%" %*
  exit /b %ERRORLEVEL%
)
node "%FILTER%" %*
exit /b %ERRORLEVEL%
:status
echo token-optimizer - status
echo Filter path: %FILTER%
if exist "%FILTER%" (
  echo Filter exists: yes
  echo.
  node "%FILTER%" stats
) else (
  echo Filter exists: no
  echo Run the installer again to restore filter.js.
  exit /b 1
)
"@ | Set-Content -Path $CommandShim -Encoding ASCII
    Write-Success "Installed command: $CommandShim"

    # Add config directory to PATH
    $UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($UserPath -notlike "*$ConfigDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$ConfigDir", "User")
        $env:PATH = "$env:PATH;$ConfigDir"
        Write-Success "Added to user PATH: $ConfigDir"
    }
    
    # Detect AI agents
    Write-Host ""
    Test-AgentConfigs
    
    # Create AGENTS.md for detected agents
    $AgentsWithConfig = @()
    
    # OpenCode AGENTS.md
    $OpenCodeAgents = Join-Path $env:APPDATA "opencode\AGENTS.md"
    $OpenCodeDir = Join-Path $env:APPDATA "opencode"
    if (Test-Path $OpenCodeDir) {
        if (-not (Test-Path $OpenCodeAgents)) {
            Write-Info "Creating AGENTS.md for OpenCode..."
            New-Item -ItemType File -Path $OpenCodeAgents -Force | Out-Null
            Add-TokenOptimizerSection $OpenCodeAgents
            Write-Success "Created $OpenCodeAgents"
        } else {
            Write-Info "Updating AGENTS.md for OpenCode..."
            Update-TokenOptimizerSection $OpenCodeAgents
            Write-Success "Updated $OpenCodeAgents"
        }
        $AgentsWithConfig += "OpenCode"
    }
    
    # Cursor AGENTS.md
    $CursorAgents = Join-Path $env:APPDATA "Cursor\AGENTS.md"
    $CursorDir = Join-Path $env:APPDATA "Cursor"
    if (Test-Path $CursorDir) {
        if (-not (Test-Path $CursorAgents)) {
            Write-Info "Creating AGENTS.md for Cursor..."
            New-Item -ItemType File -Path $CursorAgents -Force | Out-Null
            Add-TokenOptimizerSection $CursorAgents
            Write-Success "Created $CursorAgents"
        } else {
            Write-Info "Updating AGENTS.md for Cursor..."
            Update-TokenOptimizerSection $CursorAgents
            Write-Success "Updated $CursorAgents"
        }
        $AgentsWithConfig += "Cursor"
    }
    
    # Success
    Write-Host ""
    Write-Success "Installation complete!"
    Write-Host ""
    if ($AgentsWithConfig.Count -gt 0) {
        Write-Host "AGENTS.md created/updated for: $($AgentsWithConfig -join ', ')" -ForegroundColor White
    }
    Write-Host "Usage:" -ForegroundColor White
    Write-Host "  token-optimizer                  # status" -ForegroundColor Cyan
    Write-Host "  token-optimizer stats            # token totals" -ForegroundColor Cyan
    Write-Host "  token-optimizer run <command>     # filter one command" -ForegroundColor Cyan
    Write-Host "  node ~/.config/token-optimizer/filter.js <command>" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Commands:" -ForegroundColor White
    Write-Host "  stats        View token savings" -ForegroundColor Cyan
    Write-Host "  reset-stats  Clear statistics" -ForegroundColor Cyan
    Write-Host ""
}

# Main
if ($Help) { Show-Help }
if ($Uninstall) { Uninstall-TokenOptimizer }
if ($ResetStats) { Reset-Statistics }
Install-TokenOptimizer
