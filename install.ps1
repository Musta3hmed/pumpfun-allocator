<#
.SYNOPSIS
  One-file bootstrapper for the pump.fun block trade allocator.

.DESCRIPTION
  Downloads the repo, installs dependencies, creates a .env, runs the test suite,
  and tells you what to do next. Safe to re-run: an existing install is updated
  in place and your .env, keystore, and ledger are left alone.

.EXAMPLE
  .\install.ps1
  Installs to $HOME\pumpfun-allocator.

.EXAMPLE
  .\install.ps1 -Path D:\trading -Start
  Installs to D:\trading\pumpfun-allocator and launches the dashboard when done.
#>

[CmdletBinding()]
param(
  # Parent directory to install into. A 'pumpfun-allocator' folder is created here.
  [string] $Path = $HOME,

  # Launch the dashboard as soon as the install finishes.
  [switch] $Start,

  # Skip the test suite (not recommended).
  [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo    = 'Musta3hmed/pumpfun-allocator'
$Branch  = 'main'
$Target  = Join-Path $Path 'pumpfun-allocator'
$MinNode = 24

function Say  ($m) { Write-Host "  $m" }
function Step ($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`nx $m" -ForegroundColor Red; exit 1 }

# Native tools (git, npm) write progress to stderr. Under $ErrorActionPreference
# = 'Stop', Windows PowerShell 5.1 turns that into a terminating NativeCommandError
# even on success, so native calls are run with the preference relaxed and judged
# by their exit code instead.
function Invoke-Native {
  param(
    [Parameter(Mandatory)] [scriptblock] $Command,
    [string] $FailMessage
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0 -and $FailMessage) { Die $FailMessage }
}

Write-Host ""
Write-Host "pump.fun block trade allocator" -ForegroundColor White
Write-Host "This software signs transactions that spend other people's money." -ForegroundColor DarkGray
Write-Host "Read the README before you point it at a real account." -ForegroundColor DarkGray

# --- prerequisites ---------------------------------------------------------
Step "Checking prerequisites"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "Node.js is not installed. Get it from https://nodejs.org (v$MinNode or newer), then re-run this script." }

$nodeVersion = (Invoke-Native { node --version }).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt $MinNode) {
  Die "Node v$nodeVersion found, but v$MinNode or newer is required (the ledger uses the built-in node:sqlite module). Upgrade at https://nodejs.org"
}
Say "node v$nodeVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "npm was not found alongside Node. Reinstall Node.js." }
Say "npm  v$(Invoke-Native { npm --version })"

$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) { Say "git  present (updates will use git pull)" }
else      { Say "git  not found (will download a zip snapshot instead)" }

# --- fetch -----------------------------------------------------------------
$isExistingClone = (Test-Path (Join-Path $Target '.git'))

if ($isExistingClone -and $git) {
  Step "Updating existing install at $Target"
  Push-Location $Target
  try {
    $dirty = Invoke-Native { git status --porcelain }
    if ($dirty) {
      Warn "You have local changes here. Leaving them alone and skipping the pull:"
      $dirty -split "`n" | Select-Object -First 10 | ForEach-Object { Say "  $_" }
      Warn "Commit or stash them, then re-run to update."
    } else {
      Invoke-Native { git pull --quiet --ff-only origin $Branch } "git pull failed. Resolve the repo state in $Target and re-run."
      Say "updated to latest $Branch"
    }
  } finally { Pop-Location }
}
elseif (Test-Path $Target) {
  Step "Found an existing folder at $Target"
  Warn "It is not a git clone, so it will not be auto-updated."
  Warn "Delete or rename it if you want a clean install. Continuing with what is there."
}
else {
  Step "Downloading $Repo into $Target"
  New-Item -ItemType Directory -Force -Path $Path | Out-Null

  if ($git) {
    Invoke-Native { git clone --quiet --depth 1 --branch $Branch "https://github.com/$Repo.git" $Target } "git clone failed."
  } else {
    $zip     = Join-Path $env:TEMP "pumpfun-allocator-$(Get-Random).zip"
    $unpack  = Join-Path $env:TEMP "pumpfun-allocator-$(Get-Random)"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
      Expand-Archive -Path $zip -DestinationPath $unpack -Force
      $inner = Get-ChildItem $unpack -Directory | Select-Object -First 1
      Move-Item -Path $inner.FullName -Destination $Target
    } finally {
      Remove-Item $zip, $unpack -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Say "fetched"
}

if (-not (Test-Path (Join-Path $Target 'package.json'))) { Die "Install looks incomplete: no package.json in $Target" }

# --- dependencies ----------------------------------------------------------
Step "Installing dependencies"
Push-Location $Target
try {
  # 'npm ci' installs exactly what the lockfile pins and, unlike 'npm install',
  # never rewrites it. That matters here: a rewritten lockfile leaves the clone
  # dirty and blocks every future auto-update.
  if (Test-Path (Join-Path $Target 'package-lock.json')) {
    Invoke-Native { npm ci --no-audit --no-fund --loglevel=error }
    if ($LASTEXITCODE -ne 0) {
      Warn "npm ci failed (lockfile may be out of sync); falling back to npm install"
      Invoke-Native { npm install --no-audit --no-fund --loglevel=error } "npm install failed. Scroll up for the reason."
    }
  } else {
    Invoke-Native { npm install --no-audit --no-fund --loglevel=error } "npm install failed. Scroll up for the reason."
  }
  Say "dependencies installed"

  # --- configuration -------------------------------------------------------
  Step "Configuring"
  $envPath = Join-Path $Target '.env'
  if (Test-Path $envPath) {
    Say ".env already exists, leaving it untouched"
  } else {
    Copy-Item (Join-Path $Target '.env.example') $envPath
    Say "created .env from .env.example"
    Warn "It points at the public Solana RPC, which is rate limited and WILL drop fills."
    Warn "Put a private RPC URL (Helius, Triton, QuickNode) in RPC_URL before trading."
  }

  # --- verify --------------------------------------------------------------
  if (-not $SkipTests) {
    Step "Running the test suite"
    Invoke-Native { npm test --silent } "Tests failed. Do not trade with this build; open an issue with the output above."
    Say "allocation math verified"
  }
}
finally { Pop-Location }

# --- done ------------------------------------------------------------------
Write-Host "`nInstalled to $Target" -ForegroundColor Green
Write-Host @"

Next steps:

  cd "$Target"
  notepad .env                 # set RPC_URL and MAX_BLOCK_TRADE_SOL
  npm run wallet -- add        # add a managed account (repeat per client)
  npm start                    # dashboard at http://127.0.0.1:8787

Adding an account asks for the client's mandate: their name, the agreement
reference, its signed date, and the per-trade ceiling they authorized. Those
fields cap what the allocator will size for them, and every fill is written
to the audit ledger against them.

"@ -ForegroundColor Gray

if ($Start) {
  Step "Starting the dashboard (Ctrl+C to stop)"
  Push-Location $Target
  try { Invoke-Native { npm start } } finally { Pop-Location }
}
