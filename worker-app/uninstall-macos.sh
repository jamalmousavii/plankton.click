#!/bin/bash
# ============================================
#   Plankton Network Worker - macOS Uninstall
# ============================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-macos.sh -o uninstall-macos.sh && bash uninstall-macos.sh
# ============================================

set -e

PLANKTON_VERSION="1.0.0"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$HOME/plankton-worker"
PLIST_LABEL="click.plankton.worker"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# Best-effort dashboard unregister: the worker_token itself is the credential
# (same trust model as /setup). Idempotent server-side.
notify_uninstall() {
  local TOKEN=""
  if [ -f "$INSTALL_DIR/worker-app/config.json" ]; then
    TOKEN=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).worker_token||"")}catch(e){}' "$INSTALL_DIR/worker-app/config.json" 2>/dev/null)
  fi
  if [ -n "$TOKEN" ]; then
    echo -e "  Notifying plankton.click..."
    if curl -s -X POST https://plankton.click/api/workers/unregister \
      -H "Content-Type: application/json" \
      -d "{\"worker_token\": \"${TOKEN}\"}" | grep -q '"success":true'; then
      echo -e "  ${GREEN}✓ Removed from your Plankton dashboard (earnings kept in History)${NC}"
    else
      echo -e "  ${YELLOW}! Could not reach plankton.click - remove it from the dashboard (My Workers)${NC}"
    fi
  fi
}
SUCCESS=""

echo ""
echo -e "${RED}========================================${NC}"
echo -e "${RED}  Plankton Worker Uninstaller (macOS) v${PLANKTON_VERSION}${NC}"
echo -e "${RED}========================================${NC}"
echo ""
echo -e "  What do you want to remove?"
echo ""
echo -e "  ${GREEN}1${NC}) Worker only (service + app files)"
echo -e "  ${GREEN}2${NC}) Everything (worker + Ollama + all downloaded models)"
echo -e "  ${RED}0${NC}) Cancel"
echo ""

read -r -p "  Choice [0-2]: " choice

unload_service() {
  if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    echo -e "  Unloading $PLIST_LABEL..."
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    echo -e "  ${GREEN}✓ Service unloaded${NC}"
  fi
  if [ -f "$PLIST_FILE" ]; then
    echo -e "  Removing launchd plist..."
    rm -f "$PLIST_FILE"
    echo -e "  ${GREEN}✓ Plist removed${NC}"
  fi
}

case $choice in
  1)
    echo ""
    echo -e "${YELLOW}Removing worker...${NC}"

    notify_uninstall
    unload_service

    # Remove app files
    if [ -d "$INSTALL_DIR" ]; then
      echo -e "  Removing $INSTALL_DIR..."
      rm -rf "$INSTALL_DIR"
      echo -e "  ${GREEN}✓ Worker files removed${NC}"
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Worker removed successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  Ollama and models are still installed."
    echo -e "  To remove them, re-download this script (it deletes itself once done) and choose option 2."
    echo ""
    SUCCESS=1
    ;;

  2)
    echo ""
    echo -e "${RED}Removing everything...${NC}"

    notify_uninstall
    unload_service

    # Remove app files
    if [ -d "$INSTALL_DIR" ]; then
      echo -e "  Removing $INSTALL_DIR..."
      rm -rf "$INSTALL_DIR"
      echo -e "  ${GREEN}✓ Worker files removed${NC}"
    fi

    # Stop Ollama
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
      echo -e "  Stopping Ollama..."
      brew services stop ollama 2>/dev/null || pkill -x ollama 2>/dev/null || true
      echo -e "  ${GREEN}✓ Ollama stopped${NC}"
    fi

    # Remove Ollama models and data (user-level store on macOS)
    if [ -d "$HOME/.ollama" ]; then
      echo -e "  Removing Ollama models (~/.ollama)..."
      rm -rf "$HOME/.ollama"
      echo -e "  ${GREEN}✓ Ollama models removed${NC}"
    fi

    echo ""
    echo -e "  To also remove the Ollama app itself: ${YELLOW}brew uninstall ollama${NC}"
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Everything removed successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    SUCCESS=1
    ;;

  0|"")
    echo -e "  Cancelled."
    exit 0
    ;;
  *)
    echo -e "  ${RED}Invalid choice.${NC}"
    exit 1
    ;;
esac

# Self-delete only when $0 really IS this uninstaller.
SELF="$0"
if [ -n "$SUCCESS" ] && [ -f "$SELF" ] && head -n 6 "$SELF" | grep -q "Plankton Network Worker - .* Uninstall"; then
  rm -f -- "$SELF"
fi
