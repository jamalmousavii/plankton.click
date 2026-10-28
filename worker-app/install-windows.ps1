# ============================================
#   Plankton Network Worker - Windows Install
# ============================================
# Usage (PowerShell, regular user terminal):
#   Invoke-WebRequest -Uri https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-windows.ps1 -OutFile install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#   .\install-windows.ps1 -Email user@email.com -Token pw_xxx
# Re-running on an installed box opens the Manager menu (add/remove/repair
# models, token/name, update, restart) instead of reinstalling.
# ============================================

param(
  [string]$Email = "",
  [string]$Token = "",
  [string]$TokenFile = "",
  [string]$Name = "",
  [switch]$Fresh,
  [switch]$SkipDiskCheck
)

$ErrorActionPreference = "Stop"
$PLANKTON_VERSION = "1.0.0"
$INSTALL_DIR = "$HOME\plankton-worker"
$EXISTING_CONFIG = "$INSTALL_DIR\worker-app\config.json"
$TASK_NAME = "PlanktonWorker"

$MODEL_SIZES = [ordered]@{
  "llama3.3:70b" = "43 GB"; "deepseek-r1:70b" = "43 GB"; "llama3.1:8b" = "5 GB"
  "llama3.2:3b" = "2 GB"; "phi4:14b" = "9 GB"; "gpt-oss:20b" = "14 GB"
  "qwen3:32b" = "20 GB"; "qwen3-coder:30b" = "18 GB"; "qwen2.5-coder:32b" = "20 GB"
  "qwen3-vl:8b" = "8 GB"; "gemma4:12b" = "7 GB"; "gemma3:27b" = "18 GB"
  "mistral-small3.2:24b" = "15 GB"; "embeddinggemma" = "0.5 GB"
  "nomic-embed-text" = "0.3 GB"; "bge-m3" = "1.2 GB"
}

function Step-Done([string]$msg) { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Step-Warn([string]$msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Step-Fail([string]$msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-WingetPackage([string]$id, [string]$label) {
  Write-Host "  Installing $label..." -ForegroundColor Cyan
  winget install --id $id -e --silent `
    --accept-source-agreements --accept-package-agreements `
    --disable-interactivity | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Get-InstalledModels {
  $list = ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ }
  return @($list)
}

function Merge-ConfigModels([string]$op, [string[]]$list) {
  $cfg = Get-Content $EXISTING_CONFIG -Raw | ConvertFrom-Json
  $cur = @()
  if ($cfg.models) { $cur = @($cfg.models -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  if ($op -eq "add") { $next = @($cur + $list | Select-Object -Unique) }
  else { $next = @($cur | Where-Object { $list -notcontains $_ }) }
  if ($next.Count -eq 0) { Write-Host "  refusing to empty the model list" -ForegroundColor Red; return $null }
  $cfg.models = ($next -join ",")
  if ($next -notcontains $cfg.default_model) { $cfg.default_model = $next[0] }
  $cfg | ConvertTo-Json -Depth 5 | Set-Content $EXISTING_CONFIG -Encoding utf8
  Protect-Config
  return ($next -join " ")
}

function Protect-Config {
  icacls $EXISTING_CONFIG /inheritance:r /grant:r "$env:USERNAME:(R,W)" 2>$null | Out-Null
}

function Restart-Worker {
  Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue | Out-Null
  Start-Sleep 2
  $t = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  if ($t -and $t.State -eq "Running") { Step-Done "plankton-worker running" }
  else { Step-Warn "plankton-worker not running — check Task Scheduler > $TASK_NAME" }
}

function Ensure-Ollama {
  try { Invoke-RestMethod -Uri http://localhost:11434/api/tags -TimeoutSec 3 | Out-Null; return } catch {}
  Write-Host "  Starting Ollama..." -ForegroundColor Yellow
  Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
  Start-Sleep 3
}

function Show-Manager {
  Write-Host ""
  Write-Host "========================================" -ForegroundColor Green
  Write-Host "  Plankton Worker Manager v$PLANKTON_VERSION (existing install found)" -ForegroundColor Green
  Write-Host "========================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  1) Add models / 2) Remove a model / 3) Repair (re-pull) a model"
  Write-Host "  4) Change token / name / 5) Update worker app / 6) Restart service"
  Write-Host "  7) Full reinstall (fresh) / 0) Exit"
  Write-Host ""
  while ($true) {
    $mc = Read-Host "  Choice [0-7]"
    switch ($mc) {
      "1" {
        Write-Host ""; Write-Host "  Installed (Ollama):" -ForegroundColor Cyan
        Get-InstalledModels | ForEach-Object { Write-Host "   - $_" }
        Write-Host ""; Write-Host "  Available: $($MODEL_SIZES.Keys -join ' ')" -ForegroundColor Cyan
        $add = (Read-Host "  Model names to add (space-separated)").Split(" ", [StringSplitOptions]::RemoveEmptyEntries)
        if (-not $add) { Step-Warn "Nothing to add."; break }
        Ensure-Ollama
        foreach ($m in $add) {
          if (-not $MODEL_SIZES.Contains($m)) { Step-Warn "$m is not in the catalog — pulling anyway" }
          ollama pull $m 2>$null || Step-Warn "pull failed for $m"
        }
        $merged = Merge-ConfigModels "add" $add
        if ($merged) { Step-Done "Now serving: $merged"; Restart-Worker }
      }
      "2" {
        $rm = Read-Host "  Model name to remove"
        if (-not $rm) { break }
        if ($rm -eq "bge-m3") { Step-Warn "bge-m3 is required (it serves embeddings) and cannot be removed"; break }
        ollama rm $rm 2>$null || Step-Warn "$rm was not pulled locally"
        $merged = Merge-ConfigModels "remove" @($rm)
        if ($merged) { Step-Done "Now serving: $merged"; Restart-Worker }
      }
      "3" {
        $rp = Read-Host "  Model name to re-pull"
        if (-not $rp) { break }
        Ensure-Ollama
        ollama rm $rp 2>$null | Out-Null
        ollama pull $rp 2>$null
        if ($?) { Step-Done "$rp repaired" } else { Step-Warn "pull failed for $rp" }
        Restart-Worker
      }
      "4" {
        $nt = Read-Host "  New worker token (empty = keep)"
        if ($nt) {
          $nt = $nt.Trim()
          if ($nt -notmatch '^(pw|kz)_[0-9a-f]{32,64}$') { Step-Warn "Invalid token format."; break }
          $cfg = Get-Content $EXISTING_CONFIG -Raw | ConvertFrom-Json
          $cfg.worker_token = $nt
          $cfg | ConvertTo-Json -Depth 5 | Set-Content $EXISTING_CONFIG -Encoding utf8
          Protect-Config
          Step-Done "Token updated"
        }
        $nn = Read-Host "  New worker name (empty = keep)"
        if ($nn) {
          $cfg = Get-Content $EXISTING_CONFIG -Raw | ConvertFrom-Json
          $cfg.name = $nn.Substring(0, [Math]::Min(100, $nn.Length))
          $cfg | ConvertTo-Json -Depth 5 | Set-Content $EXISTING_CONFIG -Encoding utf8
          Step-Done "Name updated"
        }
        Restart-Worker
      }
      "5" {
        Write-Host "  Updating repository..." -ForegroundColor Cyan
        git -C $INSTALL_DIR pull
        Write-Host "  Installing npm dependencies..." -ForegroundColor Cyan
        npm --prefix "$INSTALL_DIR\worker-app" ci --omit=dev
        Restart-Worker
      }
      "6" { Restart-Worker }
      "7" { Write-Host "  Restarting as a fresh install..." -ForegroundColor Yellow; return $false }
      "0" { exit 0 }
      default { Step-Warn "Unknown choice." }
    }
    Write-Host ""
  }
}

# ---------- entry ----------

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Plankton Network Worker Installer (Windows) v$PLANKTON_VERSION" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

if ($TokenFile) { $Token = (Get-Content $TokenFile -Raw).Trim() }

if ((Test-Path $EXISTING_CONFIG) -and (-not $Fresh)) {
  if ((Show-Manager) -eq $false) {
    Write-Host "  Continuing with a fresh install..." -ForegroundColor Yellow
  } else { exit 0 }
}

# --- Step 1: tooling (winget) ---
Write-Host "[1/8] Checking prerequisites..." -ForegroundColor Yellow
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Step-Fail "winget not found (needs Windows 10 1709+ with App Installer from the Microsoft Store)."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Install-WingetPackage "Git.Git" "Git"
}
Step-Done "Prerequisites ready"

# --- Step 2: Node.js ---
Write-Host "[2/8] Node.js..." -ForegroundColor Yellow
$nodeOk = $false
try {
  $v = (node -v) -replace '^v', '' -split '\.' | Select-Object -First 1
  if ([int]$v -ge 18) { $nodeOk = $true; Step-Done "Node.js $(node -v) already installed" }
} catch {}
if (-not $nodeOk) {
  Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"
  Step-Done "Node.js $(node -v) installed"
}

# --- Step 3: Ollama ---
Write-Host "[3/8] Ollama..." -ForegroundColor Yellow
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Install-WingetPackage "Ollama.Ollama" "Ollama"
  Step-Done "Ollama installed"
} else { Step-Done "Ollama already installed" }
Ensure-Ollama
try {
  Invoke-RestMethod -Uri http://localhost:11434/api/tags -TimeoutSec 5 | Out-Null
  Step-Done "Ollama ready"
} catch { Step-Fail "Ollama failed to start. Launch the Ollama app once, then re-run." }

# --- Model selection (same catalog as Linux/macOS) ---
Write-Host ""
Write-Host "  Select models to install" -ForegroundColor Cyan
Write-Host "  1) llama3.1:8b (5 GB, default) / 2) llama3.3:70b / 3) deepseek-r1:70b"
Write-Host "  5) qwen3-coder:30b / 6) qwen2.5-coder:32b / 7) qwen3-vl:8b / 8) gemma4:12b"
Write-Host "  h-m) more / c-g) presets / 0) custom"
Write-Host "  + bge-m3 (1.2 GB) is always installed: it serves embeddings (API + chat over files)" -ForegroundColor Cyan
Write-Host ""
$choice = Read-Host "  Enter choice [1-8, c-m, 0] (default: 1)"
if (-not $choice) { $choice = "1" }

$SELECTED = switch ($choice) {
  "1" { @("llama3.1:8b") } "2" { @("llama3.3:70b") } "3" { @("deepseek-r1:70b") }
  "5" { @("qwen3-coder:30b") } "6" { @("qwen2.5-coder:32b") }
  "7" { @("qwen3-vl:8b") } "8" { @("gemma4:12b") }
  "c" { @("llama3.3:70b", "deepseek-r1:70b", "llama3.1:8b", "llama3.2:3b", "phi4:14b", "gpt-oss:20b", "qwen3:32b") }
  "d" { @("qwen3-coder:30b", "qwen2.5-coder:32b") }
  "e" { @("qwen3-vl:8b", "gemma4:12b", "mistral-small3.2:24b", "gemma3:27b") }
  "f" { @("llama3.1:8b", "qwen3-coder:30b", "qwen3-vl:8b") }
  "g" { @($MODEL_SIZES.Keys | Where-Object { $_ -notin @("embeddinggemma", "nomic-embed-text", "bge-m3") }) }
  "h" { @("llama3.2:3b") } "i" { @("phi4:14b") } "j" { @("gpt-oss:20b") }
  "k" { @("qwen3:32b") } "l" { @("mistral-small3.2:24b") } "m" { @("gemma3:27b") }
  "0" {
    $custom = Read-Host "  Model names (space-separated)"
    if ($custom) { @($custom.Split(" ", [StringSplitOptions]::RemoveEmptyEntries)) } else { @("llama3.1:8b") }
  }
  default { @("llama3.1:8b") }
}
# Every worker also serves embeddings (/v1/embeddings + chat RAG over large
# files), so bge-m3 is installed automatically — never a menu choice.
$SELECTED = @($SELECTED)
if ($SELECTED -notcontains "bge-m3") { $SELECTED += "bge-m3" }
Write-Host ""
Write-Host "  Installing models: $($SELECTED -join ' ')" -ForegroundColor Cyan

# --- Disk preflight (15GB policy, same as other installers) ---
if (-not $SkipDiskCheck) {
  $freeGB = [math]::Round((Get-PSDrive C).Free / 1GB)
  if ($freeGB -lt 15) { Step-Fail "Only ${freeGB}GB free on C: — model downloads need 15GB+ (or -SkipDiskCheck)." }
}

# --- Step 4: pull ---
Write-Host "[4/8] Downloading models..." -ForegroundColor Yellow
foreach ($m in $SELECTED) {
  ollama pull $m 2>$null || Step-Warn "$m may already exist or download in progress"
}
Step-Done "Models ready"

# --- Step 5: worker app ---
Write-Host "[5/8] Installing Plankton Worker..." -ForegroundColor Yellow
if (Test-Path $INSTALL_DIR) { git -C $INSTALL_DIR pull }
else { git clone https://github.com/jamalmousavii/plankton.click.git $INSTALL_DIR }
npm --prefix "$INSTALL_DIR\worker-app" ci --omit=dev
Step-Done "Worker installed at $INSTALL_DIR"

# --- Email & token ---
Write-Host ""
if (-not $Email) {
  Write-Host "  Enter your account email and worker token (get it from https://plankton.click/profile)"
  $Email = Read-Host "  Email"
}
if (-not $Token) {
  # Visible input (same UX decision as other installers).
  Write-Host "  Paste your token below (input is visible). Get it from https://plankton.click/profile"
  for ($i = 1; $i -le 3; $i++) {
    $Token = (Read-Host "  Worker Token").Trim()
    if ($Token -match '^(pw|kz)_[0-9a-f]{32,64}$') { Write-Host "  ✓ $($Token.Length) chars received" -ForegroundColor Green; break }
    Write-Host "  Invalid token (expected pw_ + 32-64 hex chars). Try again." -ForegroundColor Yellow
    $Token = ""
    if ($i -eq 3) { Step-Fail "Too many invalid attempts. Grab a fresh token and re-run." }
  }
}
if (-not $Name) {
  $hn = $env:COMPUTERNAME; if (-not $hn) { $hn = "worker" }
  $Name = Read-Host "  Worker Name [$hn]"
  if (-not $Name) { $Name = $hn }
}

# --- Step 6: system info ---
Write-Host "[6/8] Detecting system info..." -ForegroundColor Yellow
$gpu = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1).Name
if (-not $gpu) { $gpu = "Unknown" }
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
if (-not $cpu) { $cpu = "Unknown" }
Write-Host "  ✓ GPU: $gpu" -ForegroundColor Green
Write-Host "  ✓ RAM: ${ramGB} GB" -ForegroundColor Green
Write-Host "  ✓ CPU: $cpu" -ForegroundColor Green
Step-Done "System info detected"

# --- Step 7: register ---
Write-Host "[7/8] Registering worker..." -ForegroundColor Yellow
$setupBody = @{
  email = $Email; worker_token = $Token; name = $Name
  gpu_model = $gpu; ram = "${ramGB} GB"; cpu = $cpu; models = $SELECTED
} | ConvertTo-Json -Depth 5
try {
  $setupResp = Invoke-RestMethod -Uri https://plankton.click/api/workers/setup -Method POST `
    -Body $setupBody -ContentType "application/json" -TimeoutSec 30
} catch { $setupResp = $null }
if ($setupResp -and $setupResp.success) { Step-Done "Worker registered" }
else { Step-Fail "Registration failed. Check email and token." }

# --- Step 8: scheduled task + config ---
Write-Host "[8/8] Saving config + starting service..." -ForegroundColor Yellow
@{
  models = ($SELECTED -join ","); default_model = $SELECTED[0]
  worker_token = $Token; name = $Name
} | ConvertTo-Json -Depth 5 | Set-Content "$INSTALL_DIR\worker-app\config.json" -Encoding utf8
Protect-Config
Write-Host "  ✓ Configuration saved (user-only ACL)" -ForegroundColor Green

$nodePath = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodePath `
  -Argument "$INSTALL_DIR\worker-app\src\cli.js" -WorkingDirectory "$INSTALL_DIR\worker-app"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue | Out-Null
Step-Done "Service started ($TASK_NAME)"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Run this script again any time for the Manager menu (add/remove/repair models...)."
Write-Host "  Logs: Task Scheduler > $TASK_NAME, or run manually: node $INSTALL_DIR\worker-app\src\cli.js"
