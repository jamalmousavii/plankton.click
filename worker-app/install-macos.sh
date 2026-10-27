#!/bin/bash
# ============================================
#   Plankton Network Worker - macOS Install
# ============================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-macos.sh -o install-macos.sh && bash install-macos.sh
#   bash install-macos.sh --email user@email.com --token pw_xxx
# Re-running on an installed box opens the Manager menu (add/remove/repair
# models, token/name, update, restart) instead of reinstalling.
# Minimum OS: macOS 13 (Ventura). Older releases (Big Sur and below) are not
# supported — Homebrew, Node 20 and Ollama all need 13+, so the script fails
# fast here instead of breaking mid-install.
# ============================================

MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "0")
MACOS_MAJOR=$(echo "$MACOS_VER" | cut -d. -f1)
case "$MACOS_MAJOR" in
  ''|*[!0-9]*) MACOS_MAJOR=0 ;;
esac
if [ "$MACOS_MAJOR" -lt 13 ]; then
  echo "Plankton Worker needs macOS 13 (Ventura) or newer — this Mac is macOS $MACOS_VER."
  echo "Use a newer Mac, Linux, or Windows instead."
  exit 1
fi

set -e

PLANKTON_VERSION="1.0.0"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# macOS ships bash 3.2 — the picker below needs bash 4+ (associative
# arrays). Re-exec with Homebrew bash when available, else install it.
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  for BREWBASH in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    if [ -x "$BREWBASH" ]; then
      exec "$BREWBASH" "$0" "$@"
    fi
  done
  if command -v brew &> /dev/null; then
    echo -e "${YELLOW}  Installing a modern bash (macOS ships 3.2)...${NC}"
    brew install bash
    for BREWBASH in /opt/homebrew/bin/bash /usr/local/bin/bash; do
      if [ -x "$BREWBASH" ]; then
        exec "$BREWBASH" "$0" "$@"
      fi
    done
  fi
  echo -e "${RED}  ✗ bash 4+ required. Install Homebrew (https://brew.sh), re-run, and this script takes it from there.${NC}"
  exit 1
fi

# --- Helper Functions ---
spinner() {
  local pid=$1
  local msg=$2
  local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local delay=0.1
  while kill -0 "$pid" 2>/dev/null; do
    for (( i=0; i<${#spinstr}; i++ )); do
      printf "\r  ${CYAN}${spinstr:$i:1}${NC} %s" "$msg"
      sleep $delay
    done
  done
  printf "\r  \r"
}

run_with_spinner() {
  local msg=$1
  shift
  local logfile=$(mktemp)
  "$@" > "$logfile" 2>&1 &
  local pid=$!
  spinner "$pid" "$msg"
  wait "$pid" 2>/dev/null
  local exit_code=$?
  rm -f "$logfile"
  return $exit_code
}

step_start() {
  echo -e "${YELLOW}[$1/$TOTAL_STEPS] ⏳ $2${NC}"
}

step_done() {
  echo -e "${GREEN}  ✅ $1${NC}"
}

step_fail() {
  echo -e "${RED}  ⚠ $1${NC}"
}

# Model size map (same catalog as the Linux installers)
declare -A MODEL_SIZES
MODEL_SIZES[llama3.3:70b]="43 GB"
MODEL_SIZES[deepseek-r1:70b]="43 GB"
MODEL_SIZES[llama3.1:8b]="5 GB"
MODEL_SIZES[llama3.2:3b]="2 GB"
MODEL_SIZES[phi4:14b]="9 GB"
MODEL_SIZES[gpt-oss:20b]="14 GB"
MODEL_SIZES[qwen3:32b]="20 GB"
MODEL_SIZES[qwen3-coder:30b]="18 GB"
MODEL_SIZES[qwen2.5-coder:32b]="20 GB"
MODEL_SIZES[qwen3-vl:8b]="8 GB"
MODEL_SIZES[gemma4:12b]="7 GB"
MODEL_SIZES[gemma3:27b]="18 GB"
MODEL_SIZES[mistral-small3.2:24b]="15 GB"
MODEL_SIZES[embeddinggemma]="0.5 GB"
MODEL_SIZES[nomic-embed-text]="0.3 GB"
MODEL_SIZES[bge-m3]="1.2 GB"

TOTAL_STEPS=8
SCRIPT_START=$(date +%s)

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Plankton Network Worker Installer (macOS) v${PLANKTON_VERSION}${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Parse --email, --token / --token-file, --name and --fresh flags
USER_EMAIL=""
WORKER_TOKEN=""
WORKER_NAME=""
PLANKTON_FRESH="0"
while [[ $# -gt 0 ]]; do
  case $1 in
    --email) USER_EMAIL="$2"; shift 2 ;;
    --token) WORKER_TOKEN="$2"; shift 2 ;;
    --token-file) WORKER_TOKEN=$(tr -d '\r\n' < "$2" 2>/dev/null); shift 2 ;;
    --name) WORKER_NAME="$2"; shift 2 ;;
    --fresh) PLANKTON_FRESH="1"; shift ;;
    *) shift ;;
  esac
done

INSTALL_DIR="$HOME/plankton-worker"
EXISTING_CONFIG="$INSTALL_DIR/worker-app/config.json"
PLIST_LABEL="click.plankton.worker"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# --- Management mode (v3.42.0): same contract as the Linux installers ---
manage_config_models() { # $1 = add|remove, $2 = space-separated models
  local op="$1" list="$2" cfg="$EXISTING_CONFIG"
  node -e '
    const fs = require("fs");
    const [cfg, op, raw] = [process.argv[1], process.argv[2], process.argv[3] || ""];
    let c = {};
    try { c = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch (e) { console.error("no config"); process.exit(1); }
    const cur = String(c.models || "").split(",").map((s) => s.trim()).filter(Boolean);
    const arg = raw.split(" ").map((s) => s.trim()).filter(Boolean);
    let next = cur;
    if (op === "add") next = [...new Set([...cur, ...arg])];
    if (op === "remove") next = cur.filter((m) => !arg.includes(m));
    if (next.length === 0) { console.error("refusing to empty the model list"); process.exit(1); }
    c.models = next.join(",");
    if (!next.includes(c.default_model)) c.default_model = next[0];
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
    console.log(next.join(" "));
  ' "$cfg" "$op" "$list"
}

manage_restart_worker() {
  launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || launchctl load "$PLIST_FILE" 2>/dev/null || true
  sleep 2
  launchctl list 2>/dev/null | grep -q "$PLIST_LABEL" \
    && echo -e "  ${GREEN}✓ plankton-worker loaded${NC}" \
    || echo -e "  ${RED}✗ plankton-worker not loaded — check: tail -30 $INSTALL_DIR/worker-app/worker.log${NC}"
}

manage_ensure_ollama() {
  if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e "  ${YELLOW}  Starting Ollama...${NC}"
    (brew services start ollama 2>/dev/null || nohup ollama serve > /dev/null 2>&1 &) || true
    sleep 3
  fi
}

manage_add_models() {
  echo ""
  echo -e "  ${CYAN}Installed models (Ollama):${NC}"
  ollama list 2>/dev/null | tail -n +2 | awk '{print "   - " $1}' || true
  echo ""
  echo -e "  ${CYAN}Available:${NC} $(printf '%s ' "${!MODEL_SIZES[@]}" | tr ' ' '\n' | sort | tr '\n' ' ')"
  echo ""
  read -r -p "  Model names to add (space-separated): " ADD
  [ -z "$ADD" ] && { echo -e "  ${YELLOW}Nothing to add.${NC}"; return; }
  manage_ensure_ollama
  for MODEL in $ADD; do
    [ -z "${MODEL_SIZES[$MODEL]:-}" ] && echo -e "  ${YELLOW}  ⚠ $MODEL is not in the catalog — pulling anyway${NC}"
    ollama pull "$MODEL" || echo -e "  ${YELLOW}  ⚠ pull failed for $MODEL${NC}"
  done
  MERGED=$(manage_config_models add "$ADD") || return
  echo -e "  ${GREEN}✓ Now serving: $MERGED${NC}"
  manage_restart_worker
}

manage_remove_model() {
  read -r -p "  Model name to remove: " RM
  [ -z "$RM" ] && return
  ollama rm "$RM" 2>/dev/null || echo -e "  ${YELLOW}  ⚠ $RM was not pulled locally${NC}"
  MERGED=$(manage_config_models remove "$RM") || return
  echo -e "  ${GREEN}✓ Now serving: $MERGED${NC}"
  manage_restart_worker
}

manage_repair_model() {
  read -r -p "  Model name to re-pull: " RP
  [ -z "$RP" ] && return
  manage_ensure_ollama
  ollama rm "$RP" 2>/dev/null || true
  ollama pull "$RP" && echo -e "  ${GREEN}✓ $RP repaired${NC}" || echo -e "  ${RED}  ✗ pull failed for $RP${NC}"
  manage_restart_worker
}

manage_identity() {
  local NT=""
  read -r -p "  New worker token (empty = keep): " NT
  if [ -n "$NT" ]; then
    NT=$(printf '%s' "$NT" | tr -d ' \t\r\n')
    [[ "$NT" =~ ^(pw|kz)_[0-9a-f]{32,64}$ ]] || { echo -e "  ${RED}  ✗ Invalid token format${NC}"; return; }
    node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.worker_token=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$EXISTING_CONFIG" "$NT"
    chmod 600 "$EXISTING_CONFIG"
    echo -e "  ${GREEN}✓ Token updated${NC}"
  fi
  read -r -p "  New worker name (empty = keep): " NN
  if [ -n "$NN" ]; then
    node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.name=process.argv[2].slice(0,100);fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$EXISTING_CONFIG" "$NN"
    echo -e "  ${GREEN}✓ Name updated${NC}"
  fi
  manage_restart_worker
}

manage_update_app() {
  run_with_spinner "Updating repository..." bash -c "cd '$INSTALL_DIR' && git pull"
  run_with_spinner "Installing npm dependencies..." bash -c "cd '$INSTALL_DIR/worker-app' && npm ci --omit=dev"
  manage_restart_worker
}

manage_menu() {
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  Plankton Worker Manager v${PLANKTON_VERSION} (existing install found)${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo -e "  ${GREEN}1${NC}) ➕ Add models"
  echo -e "  ${GREEN}2${NC}) ➖ Remove a model"
  echo -e "  ${GREEN}3${NC}) 🔧 Repair (re-pull) a model"
  echo -e "  ${GREEN}4${NC}) 🔑 Change token / name"
  echo -e "  ${GREEN}5${NC}) ⬆️  Update worker app"
  echo -e "  ${GREEN}6${NC}) 🔄 Restart worker service"
  echo -e "  ${GREEN}7${NC}) 🆕 Full reinstall (fresh)"
  echo -e "  ${GREEN}0${NC}) Exit"
  echo ""
  while true; do
    read -r -p "  Choice [0-7]: " MC
    case "$MC" in
      1) manage_add_models ;;
      2) manage_remove_model ;;
      3) manage_repair_model ;;
      4) manage_identity ;;
      5) manage_update_app ;;
      6) manage_restart_worker ;;
      7) echo -e "  ${YELLOW}Restarting as a fresh install...${NC}"; return 1 ;;
      0|q|"") exit 0 ;;
      *) echo -e "  ${YELLOW}Unknown choice.${NC}" ;;
    esac
    echo ""
  done
}

if [ -f "$EXISTING_CONFIG" ] && [ "$PLANKTON_FRESH" != "1" ]; then
  if manage_menu; then
    exit 0
  fi
  # Choice 7 (full reinstall) falls through to the fresh flow below.
fi

# --- Step 1: Prerequisites (Homebrew) ---
step_start 1 "Checking prerequisites..."
STEP_START=$(date +%s)
if ! command -v brew &> /dev/null; then
  echo -e "  ${RED}  ✗ Homebrew not found. Install it from https://brew.sh, then re-run this script.${NC}"
  exit 1
fi
if ! xcode-select -p &> /dev/null; then
  echo -e "  ${YELLOW}  Xcode Command Line Tools missing — running installer (re-run this script when it finishes).${NC}"
  xcode-select --install || true
  exit 1
fi
# Old Intel Macs without AVX2 cannot run Ollama builds.
if [ "$(uname -m)" != "arm64" ]; then
  if ! sysctl -n machdep.cpu.features 2>/dev/null | grep -q AVX2; then
    echo -e "  ${RED}  ✗ This Intel Mac lacks AVX2 — Ollama (and working) is not supported on it.${NC}"
    exit 1
  fi
fi
STEP_END=$(date +%s)
step_done "Prerequisites ready ($(($STEP_END - $STEP_START))s)"

# --- Step 2: Node.js ---
step_start 2 "Installing Node.js..."
STEP_START=$(date +%s)
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
  run_with_spinner "Installing Node.js 20..." brew install node@20
  brew link --overwrite node@20 2>/dev/null || true
  NODE_VER=$(node -v)
  STEP_END=$(date +%s)
  step_done "Node.js ${NODE_VER} installed ($(($STEP_END - $STEP_START))s)"
else
  NODE_VER=$(node -v)
  STEP_END=$(date +%s)
  step_done "Node.js ${NODE_VER} already installed ($(($STEP_END - $STEP_START))s)"
fi
command -v jq &> /dev/null || run_with_spinner "Installing jq..." brew install jq

# --- Step 3: Ollama ---
step_start 3 "Installing Ollama..."
STEP_START=$(date +%s)
if ! command -v ollama &> /dev/null; then
  run_with_spinner "Installing Ollama..." brew install ollama
  STEP_END=$(date +%s)
  step_done "Ollama installed ($(($STEP_END - $STEP_START))s)"
else
  STEP_END=$(date +%s)
  step_done "Ollama already installed ($(($STEP_END - $STEP_START))s)"
fi

brew services start ollama 2>/dev/null || true
sleep 2

if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo -e "  ${YELLOW}  Starting Ollama manually...${NC}"
  nohup ollama serve > /dev/null 2>&1 &
  sleep 3
fi

echo -ne "  ${CYAN}  Waiting for Ollama to be ready...${NC}"
for i in $(seq 1 30); do
  if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e " ${GREEN}ready${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e " ${RED}timeout${NC}"
    echo -e "  ${RED}  ✗ Ollama failed to start. Try: brew services restart ollama${NC}"
    exit 1
  fi
  sleep 1
done

# --- Model Selection (same catalog as the Linux installers) ---
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Select models to install${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "  ${CYAN}--- Chat ---${NC}"
echo -e "  ${GREEN}1${NC}) llama3.1:8b        (5 GB)   - Best budget all-rounder"
echo -e "  ${GREEN}2${NC}) llama3.3:70b       (43 GB)  - Best large model"
echo -e "  ${GREEN}3${NC}) deepseek-r1:70b    (43 GB)  - Best reasoning"
echo -e "  ${GREEN}h${NC}) llama3.2:3b        (2 GB)   - Fastest everyday chat"
echo -e "  ${GREEN}i${NC}) phi4:14b           (9 GB)   - Best small reasoner"
echo -e "  ${GREEN}j${NC}) gpt-oss:20b        (14 GB)  - OpenAI open-weight"
echo -e "  ${GREEN}k${NC}) qwen3:32b          (20 GB)  - Thinking reasoning"
echo ""
echo -e "  ${CYAN}--- Code ---${NC}"
echo -e "  ${GREEN}5${NC}) qwen3-coder:30b    (18 GB)  - Best coding model"
echo -e "  ${GREEN}6${NC}) qwen2.5-coder:32b  (20 GB)  - Best dense coder"
echo ""
echo -e "  ${CYAN}--- Vision ---${NC}"
echo -e "  ${GREEN}7${NC}) qwen3-vl:8b        (8 GB)   - Best vision model"
echo -e "  ${GREEN}8${NC}) gemma4:12b         (7 GB)   - Multimodal + tools"
echo -e "  ${GREEN}l${NC}) mistral-small3.2:24b (15 GB) - Fast vision + tools"
echo -e "  ${GREEN}m${NC}) gemma3:27b         (18 GB)  - Google multimodal"
echo ""
echo -e "  ${CYAN}--- Embedding ---${NC}"
echo -e "  ${GREEN}9${NC}) embeddinggemma      (0.5 GB) - Newest embeddings"
echo -e "  ${GREEN}a${NC}) nomic-embed-text   (0.3 GB) - Classic default"
echo -e "  ${GREEN}b${NC}) bge-m3             (1.2 GB) - Multilingual RAG"
echo ""
echo -e "  ${YELLOW}--- Presets ---${NC}"
echo -e "  ${GREEN}c${NC}) All Chat (1+2+3+h+i+j+k)"
echo -e "  ${GREEN}d${NC}) All Code (5+6)"
echo -e "  ${GREEN}e${NC}) All Vision (7+8+l+m)"
echo -e "  ${GREEN}f${NC}) All recommended (1+5+7+9)"
echo -e "  ${GREEN}g${NC}) Everything (all 16 local models)"
echo -e "  ${GREEN}0${NC}) Custom (enter model names manually)"
echo ""

SELECTED_MODELS=""

read -r -p "  Enter choice [1-9, a-m, 0] (default: 1): " choice
choice=${choice:-1}

pick_models() {
case $choice in
  1) SELECTED_MODELS="llama3.1:8b" ;;
  2) SELECTED_MODELS="llama3.3:70b" ;;
  3) SELECTED_MODELS="deepseek-r1:70b" ;;
  5) SELECTED_MODELS="qwen3-coder:30b" ;;
  6) SELECTED_MODELS="qwen2.5-coder:32b" ;;
  7) SELECTED_MODELS="qwen3-vl:8b" ;;
  8) SELECTED_MODELS="gemma4:12b" ;;
  9) SELECTED_MODELS="embeddinggemma" ;;
  a) SELECTED_MODELS="nomic-embed-text" ;;
  b) SELECTED_MODELS="bge-m3" ;;
  c) SELECTED_MODELS="llama3.3:70b deepseek-r1:70b llama3.1:8b llama3.2:3b phi4:14b gpt-oss:20b qwen3:32b" ;;
  d) SELECTED_MODELS="qwen3-coder:30b qwen2.5-coder:32b" ;;
  e) SELECTED_MODELS="qwen3-vl:8b gemma4:12b mistral-small3.2:24b gemma3:27b" ;;
  f) SELECTED_MODELS="llama3.1:8b qwen3-coder:30b qwen3-vl:8b embeddinggemma" ;;
  g) SELECTED_MODELS="llama3.3:70b deepseek-r1:70b llama3.1:8b qwen3-coder:30b qwen2.5-coder:32b qwen3-vl:8b gemma4:12b embeddinggemma nomic-embed-text bge-m3 llama3.2:3b phi4:14b gpt-oss:20b qwen3:32b mistral-small3.2:24b gemma3:27b" ;;
  h) SELECTED_MODELS="llama3.2:3b" ;;
  i) SELECTED_MODELS="phi4:14b" ;;
  j) SELECTED_MODELS="gpt-oss:20b" ;;
  k) SELECTED_MODELS="qwen3:32b" ;;
  l) SELECTED_MODELS="mistral-small3.2:24b" ;;
  m) SELECTED_MODELS="gemma3:27b" ;;
  0)
    echo ""
    echo -e "  ${CYAN}Select models by number:${NC}"
    echo -e "  ${GREEN}1${NC}) llama3.1:8b        (5 GB)"
    echo -e "  ${GREEN}2${NC}) llama3.3:70b       (43 GB)"
    echo -e "  ${GREEN}3${NC}) deepseek-r1:70b    (43 GB)"
    echo -e "  ${GREEN}5${NC}) qwen3-coder:30b    (18 GB)"
    echo -e "  ${GREEN}6${NC}) qwen2.5-coder:32b  (20 GB)"
    echo -e "  ${GREEN}7${NC}) qwen3-vl:8b        (8 GB)"
    echo -e "  ${GREEN}8${NC}) gemma4:12b         (7 GB)"
    echo -e "  ${GREEN}9${NC}) embeddinggemma      (0.5 GB)"
    echo -e "  ${GREEN}a${NC}) nomic-embed-text   (0.3 GB)"
    echo -e "  ${GREEN}b${NC}) bge-m3             (1.2 GB)"
    echo -e "  ${GREEN}h${NC}) llama3.2:3b        (2 GB)"
    echo -e "  ${GREEN}i${NC}) phi4:14b           (9 GB)"
    echo -e "  ${GREEN}j${NC}) gpt-oss:20b        (14 GB)"
    echo -e "  ${GREEN}k${NC}) qwen3:32b          (20 GB)"
    echo -e "  ${GREEN}l${NC}) mistral-small3.2:24b (15 GB)"
    echo -e "  ${GREEN}m${NC}) gemma3:27b         (18 GB)"
    echo ""
    read -r -p "  Model letters/numbers (e.g. 1 5 7): " custom_input
    SELECTED_MODELS=""
    for num in $custom_input; do
      case $num in
        1) SELECTED_MODELS="$SELECTED_MODELS llama3.1:8b" ;;
        2) SELECTED_MODELS="$SELECTED_MODELS llama3.3:70b" ;;
        3) SELECTED_MODELS="$SELECTED_MODELS deepseek-r1:70b" ;;
        5) SELECTED_MODELS="$SELECTED_MODELS qwen3-coder:30b" ;;
        6) SELECTED_MODELS="$SELECTED_MODELS qwen2.5-coder:32b" ;;
        7) SELECTED_MODELS="$SELECTED_MODELS qwen3-vl:8b" ;;
        8) SELECTED_MODELS="$SELECTED_MODELS gemma4:12b" ;;
        9) SELECTED_MODELS="$SELECTED_MODELS embeddinggemma" ;;
        a) SELECTED_MODELS="$SELECTED_MODELS nomic-embed-text" ;;
        b) SELECTED_MODELS="$SELECTED_MODELS bge-m3" ;;
        h) SELECTED_MODELS="$SELECTED_MODELS llama3.2:3b" ;;
        i) SELECTED_MODELS="$SELECTED_MODELS phi4:14b" ;;
        j) SELECTED_MODELS="$SELECTED_MODELS gpt-oss:20b" ;;
        k) SELECTED_MODELS="$SELECTED_MODELS qwen3:32b" ;;
        l) SELECTED_MODELS="$SELECTED_MODELS mistral-small3.2:24b" ;;
        m) SELECTED_MODELS="$SELECTED_MODELS gemma3:27b" ;;
      esac
    done
    SELECTED_MODELS=$(echo "$SELECTED_MODELS" | xargs)
    SELECTED_MODELS=${SELECTED_MODELS:-"llama3.1:8b"}
    ;;
  *) SELECTED_MODELS="llama3.1:8b" ;;
esac
}

pick_models

echo ""
echo -e "${CYAN}  Installing models: ${SELECTED_MODELS}${NC}"
echo ""

# Disk preflight (same 15GB policy as Linux; unified-memory Macs share it
# with the system, so the warning matters even more here).
if [ "${PLANKTON_SKIP_DISK_CHECK:-0}" != "1" ]; then
  FREE_KB=$(df -Pk / | awk 'NR==2 {print $4}')
  FREE_GB=$(( ${FREE_KB:-0} / 1024 / 1024 ))
  if [ "$FREE_GB" -lt 15 ]; then
    echo -e "  ${RED}  ✗ Only ${FREE_GB}GB free on / — model downloads need ≥15GB.${NC}"
    echo -e "  ${YELLOW}  Free up disk space and re-run, or set PLANKTON_SKIP_DISK_CHECK=1 to skip this check.${NC}"
    exit 1
  fi
fi

# --- Step 4: Download Models ---
step_start 4 "Downloading models..."
STEP_START=$(date +%s)
MODEL_COUNT=$(echo "$SELECTED_MODELS" | wc -w)
MODEL_CURRENT=0

for MODEL in $SELECTED_MODELS; do
  MODEL_CURRENT=$((MODEL_CURRENT + 1))
  SIZE="${MODEL_SIZES[$MODEL]:-unknown}"
  echo -e "  ${CYAN}[${MODEL_CURRENT}/${MODEL_COUNT}]${NC} 📦 ${BOLD}${MODEL}${NC} (${SIZE})"
  ollama pull "$MODEL" || echo -e "  ${YELLOW}  ⚠ ${MODEL} may already exist or download in progress${NC}"
  echo ""
done

STEP_END=$(date +%s)
ELAPSED=$((STEP_END - STEP_START))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))
if [ $MINUTES -gt 0 ]; then
  step_done "Models ready (${MINUTES}m ${SECONDS}s)"
else
  step_done "Models ready (${SECONDS}s)"
fi

# --- Step 5: Install Worker ---
step_start 5 "Installing Plankton Worker..."
STEP_START=$(date +%s)
if [ -d "$INSTALL_DIR" ]; then
  run_with_spinner "Updating repository..." bash -c "cd '$INSTALL_DIR' && git pull"
else
  run_with_spinner "Cloning repository..." git clone https://github.com/jamalmousavii/plankton.click.git "$INSTALL_DIR"
fi
run_with_spinner "Installing npm dependencies..." bash -c "cd '$INSTALL_DIR/worker-app' && npm ci --omit=dev"
STEP_END=$(date +%s)
step_done "Worker installed at $INSTALL_DIR ($(($STEP_END - $STEP_START))s)"

# --- Email & Token ---
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Connect to Plankton Network${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

if [ -z "$USER_EMAIL" ]; then
  echo -e "  Enter your account email and worker token"
  echo -e "  (Get your token from https://plankton.click/profile)"
  echo ""
  read -r -p "  Email: " USER_EMAIL
fi

if [ -z "$WORKER_TOKEN" ]; then
  # Visible input (same UX decision as the Linux installers): paste shows
  # so mistakes are obvious. Not for shared terminals/recordings.
  echo -e "  Paste your token below (input is visible). Get it from https://plankton.click/profile"
  for ATTEMPT in 1 2 3; do
    read -r -p "  Worker Token: " WORKER_TOKEN
    WORKER_TOKEN=$(printf '%s' "$WORKER_TOKEN" | tr -d ' \t\r\n' | sed -e 's/\x1b\[200~//g' -e 's/\x1b\[201~//g')
    if [[ "$WORKER_TOKEN" =~ ^(pw|kz)_[0-9a-f]{32,64}$ ]]; then
      echo -e "  ${GREEN}✓ ${#WORKER_TOKEN} chars received${NC}"
      break
    fi
    echo -e "  ${YELLOW}Invalid token (expected pw_ + 32-64 hex chars). Try again.${NC}"
    WORKER_TOKEN=""
    if [ "$ATTEMPT" -eq 3 ]; then
      echo -e "  ${RED}Too many invalid attempts. Grab a fresh token from https://plankton.click/profile and re-run.${NC}"
      exit 1
    fi
  done
fi

# --- Worker name (shown in dashboard) ---
if [ -z "$WORKER_NAME" ]; then
  DEFAULT_NAME=$(hostname 2>/dev/null || echo "worker")
  read -r -p "  Worker Name [${DEFAULT_NAME}]: " WORKER_NAME
  WORKER_NAME=${WORKER_NAME:-$DEFAULT_NAME}
fi

# --- Step 6: Detect System ---
step_start 6 "Detecting system info..."
STEP_START=$(date +%s)

CPU_MODEL=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
GPU_MODEL=$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}')
[ -z "$GPU_MODEL" ] && GPU_MODEL="$CPU_MODEL"
echo -e "  ${GREEN}✓ GPU: ${GPU_MODEL}${NC}"

MEM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
RAM_SIZE="$(( MEM_BYTES / 1024 / 1024 / 1024 )) GB"
[ "$MEM_BYTES" = "0" ] && RAM_SIZE="Unknown"
echo -e "  ${GREEN}✓ RAM: ${RAM_SIZE}${NC}"
echo -e "  ${GREEN}✓ CPU: ${CPU_MODEL}${NC}"

STEP_END=$(date +%s)
step_done "System info detected ($(($STEP_END - $STEP_START))s)"

# --- Step 7: Register Worker ---
step_start 7 "Registering worker..."
STEP_START=$(date +%s)

command -v jq &> /dev/null || brew install jq
SETUP_PAYLOAD=$(jq -n \
  --arg email "$USER_EMAIL" \
  --arg token "$WORKER_TOKEN" \
  --arg name "$WORKER_NAME" \
  --arg gpu "$GPU_MODEL" \
  --arg ram "$RAM_SIZE" \
  --arg cpu "$CPU_MODEL" \
  --arg models "$SELECTED_MODELS" \
  '{email: $email, worker_token: $token, name: $name, gpu_model: $gpu, ram: $ram, cpu: $cpu, models: ($models | split(" ") | map(select(length > 0)))}')

SETUP_RESPONSE=$(printf '%s' "$SETUP_PAYLOAD" | curl -s -X POST https://plankton.click/api/workers/setup \
  -H "Content-Type: application/json" \
  --data-binary @-)

STEP_END=$(date +%s)
if echo "$SETUP_RESPONSE" | grep -q '"success":true'; then
  step_done "Worker registered ($(($STEP_END - $STEP_START))s)"
else
  step_fail "Registration failed. Check email and token."
  echo -e "  ${YELLOW}Response: $SETUP_RESPONSE${NC}"
  exit 1
fi

# --- Step 8: launchd Service ---
step_start 8 "Saving config + starting service..."
STEP_START=$(date +%s)

jq -n \
  --arg models "$(echo "$SELECTED_MODELS" | tr ' ' ',')" \
  --arg default_model "$(echo "$SELECTED_MODELS" | awk '{print $1}')" \
  --arg worker_token "$WORKER_TOKEN" \
  --arg name "$WORKER_NAME" \
  '{models: $models, default_model: $default_model, worker_token: $worker_token, name: $name}' \
  > "$INSTALL_DIR/worker-app/config.json"
chmod 600 "$INSTALL_DIR/worker-app/config.json"
echo -e "  ${GREEN}✓ Configuration saved (chmod 600)${NC}"

NODE_PATH=$(which node)
UNIT_TEMPLATE="$INSTALL_DIR/worker-app/click.plankton.worker.plist"
if [ ! -f "$UNIT_TEMPLATE" ]; then
  echo -e "${RED}  ✗ Missing $UNIT_TEMPLATE — run git pull in $INSTALL_DIR and retry${NC}"
  exit 1
fi
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@NODE@|$NODE_PATH|g" \
    -e "s|@WORKDIR@|$INSTALL_DIR/worker-app|g" \
    "$UNIT_TEMPLATE" > "$PLIST_FILE"

launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load "$PLIST_FILE"
sleep 2
launchctl list 2>/dev/null | grep -q "$PLIST_LABEL" \
  && echo -e "  ${GREEN}✓ Service loaded${NC}" \
  || echo -e "  ${YELLOW}  ⚠ Service may not be loaded — check: launchctl list | grep plankton${NC}"

STEP_END=$(date +%s)
step_done "Service started ($(($STEP_END - $STEP_START))s)"

# --- Summary ---
SCRIPT_END=$(date +%s)
TOTAL_ELAPSED=$((SCRIPT_END - SCRIPT_START))
TOTAL_MINUTES=$((TOTAL_ELAPSED / 60))
TOTAL_SECONDS=$((TOTAL_ELAPSED % 60))

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  Email:  ${GREEN}${USER_EMAIL}${NC}"
echo -e "  GPU:    ${GREEN}${GPU_MODEL}${NC}"
echo -e "  RAM:    ${GREEN}${RAM_SIZE}${NC}"
echo -e "  CPU:    ${GREEN}${CPU_MODEL}${NC}"
echo ""
echo -e "  Models installed:"
for MODEL in $SELECTED_MODELS; do
  SIZE="${MODEL_SIZES[$MODEL]:-?}"
  echo -e "    ${GREEN}✓ $MODEL${NC} (${SIZE})"
done
echo ""
echo -e "  Service: ${GREEN}${PLIST_LABEL}${NC}"
echo -e "  Status:  ${YELLOW}launchctl list | grep plankton${NC}"
echo -e "  Logs:    ${YELLOW}tail -f $INSTALL_DIR/worker-app/worker.log${NC}"
echo -e "  Stop:    ${YELLOW}launchctl unload $PLIST_FILE${NC}"
echo -e "  Start:   ${YELLOW}launchctl load $PLIST_FILE${NC}"
echo ""
echo -e "  ${BOLD}Total time: ${TOTAL_MINUTES}m ${TOTAL_SECONDS}s${NC}"
echo ""
# Self-delete only when $0 really IS this installer (same guard as Linux).
SELF="$0"
if [ -f "$SELF" ] && head -n 6 "$SELF" | grep -q "Plankton Network Worker - .* Install"; then
  rm -f -- "$SELF"
fi
