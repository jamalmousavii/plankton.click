#!/bin/bash
# ============================================
#   Plankton Network Worker - RedHat/CentOS/Fedora Uninstall
# ============================================
# Usage:
#   wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-redhat.sh && bash uninstall-redhat.sh
# ============================================

set -e

PLANKTON_VERSION="1.0.0"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$HOME/plankton-worker"

# Tell the Plankton server this machine is gone so the row leaves "My Workers"
# (earnings stay in History instead of lingering as offline forever).
# The token lives in the config we are about to delete, so read it first.
# Never blocks or fails the uninstall — worst case the user removes the
# entry from the dashboard by hand.
notify_uninstall() {
  local cfg="$INSTALL_DIR/worker-app/config.json"
  local token=""
  if [ -f "$cfg" ]; then
    token=$(grep -o '"worker_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$cfg" | head -n 1 | sed 's/.*"worker_token"[[:space:]]*:[[:space:]]*"//; s/"$//')
  fi
  if [ -z "$token" ]; then
    echo -e "  ${YELLOW}! No saved worker token - remove this worker from the dashboard (My Workers)${NC}"
    return 0
  fi
  # H4: the token never enters curl's argv (`ps`-readable) — stream it.
  if printf '{"worker_token":"%s"}' "$token" | curl -fsS --max-time 15 -X POST https://plankton.click/api/workers/unregister \
      -H 'Content-Type: application/json' \
      --data-binary @- > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Removed from your Plankton dashboard (earnings kept in History)${NC}"
  else
    echo -e "  ${YELLOW}! Could not reach plankton.click - remove it from the dashboard (My Workers)${NC}"
  fi
}
SUCCESS=""

echo ""
echo -e "${RED}========================================${NC}"
echo -e "${RED}  Plankton Worker Uninstaller (RedHat/Fedora) v${PLANKTON_VERSION}${NC}"
echo -e "${RED}========================================${NC}"
echo ""
echo -e "  What do you want to remove?"
echo ""
echo -e "  ${GREEN}1${NC}) Worker only (service + app files)"
echo -e "  ${GREEN}2${NC}) Everything (worker + Ollama + all downloaded models)"
echo -e "  ${RED}0${NC}) Cancel"
echo ""

read -r -p "  Choice [0-2]: " choice

case $choice in
  1)
    echo ""
    echo -e "${YELLOW}Removing worker...${NC}"

    notify_uninstall

    # Stop service
    if systemctl is-active --quiet plankton-worker 2>/dev/null; then
      echo -e "  Stopping plankton-worker service..."
      sudo systemctl stop plankton-worker
      echo -e "  ${GREEN}✓ Service stopped${NC}"
    fi

    # Disable service
    if systemctl is-enabled --quiet plankton-worker 2>/dev/null; then
      echo -e "  Disabling plankton-worker service..."
      sudo systemctl disable plankton-worker
      echo -e "  ${GREEN}✓ Service disabled${NC}"
    fi

    # Remove service file
    if [ -f /etc/systemd/system/plankton-worker.service ]; then
      echo -e "  Removing service file..."
      sudo rm -f /etc/systemd/system/plankton-worker.service
      sudo systemctl daemon-reload
      echo -e "  ${GREEN}✓ Service file removed${NC}"
    fi

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
    echo -e "  To remove them, re-download this script (it deletes itself once done) and choose option 2:"
    echo -e " ${CYAN}wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-redhat.sh && bash uninstall-redhat.sh${NC}"
    echo ""
    SUCCESS=1
    ;;

  2)
    echo ""
    echo -e "${RED}Removing everything...${NC}"

    notify_uninstall

    # Stop worker service
    if systemctl is-active --quiet plankton-worker 2>/dev/null; then
      echo -e "  Stopping plankton-worker service..."
      sudo systemctl stop plankton-worker
    fi

    # Disable worker service
    if systemctl is-enabled --quiet plankton-worker 2>/dev/null; then
      sudo systemctl disable plankton-worker
    fi

    # Remove worker service file
    if [ -f /etc/systemd/system/plankton-worker.service ]; then
      sudo rm -f /etc/systemd/system/plankton-worker.service
      sudo systemctl daemon-reload
      echo -e "  ${GREEN}✓ Worker service removed${NC}"
    fi

    # Remove worker app files
    if [ -d "$INSTALL_DIR" ]; then
      rm -rf "$INSTALL_DIR"
      echo -e "  ${GREEN}✓ Worker files removed${NC}"
    fi

    # Stop Ollama
    if systemctl is-active --quiet ollama 2>/dev/null; then
      echo -e "  Stopping Ollama service..."
      sudo systemctl stop ollama
    fi

    # Disable Ollama
    if systemctl is-enabled --quiet ollama 2>/dev/null; then
      sudo systemctl disable ollama
    fi

    # Remove Ollama binary
    if [ -f /usr/local/bin/ollama ]; then
      echo -e "  Removing Ollama binary..."
      sudo rm -f /usr/local/bin/ollama
      echo -e "  ${GREEN}✓ Ollama binary removed${NC}"
    fi

    # Remove Ollama service file
    if [ -f /etc/systemd/system/ollama.service ]; then
      sudo rm -f /etc/systemd/system/ollama.service
      sudo systemctl daemon-reload
    fi

    # Remove Ollama models and data (M9: BOTH stores — the packaged service
    # runs as the `ollama` user whose models live in /usr/share/ollama/.ollama,
    # which is where the GBs actually are; ~/.ollama only covers manual runs).
    REMOVED_STORES=0
    if [ -d "$HOME/.ollama" ]; then
      echo -e "  Removing Ollama models (~/.ollama)..."
      rm -rf "$HOME/.ollama"
      REMOVED_STORES=1
    fi
    if [ -d /usr/share/ollama/.ollama ]; then
      echo -e "  Removing system Ollama models (/usr/share/ollama/.ollama)..."
      sudo rm -rf /usr/share/ollama/.ollama
      REMOVED_STORES=1
    fi
    if [ -d /var/lib/ollama/models ]; then
      echo -e "  Removing system Ollama models (/var/lib/ollama/models)..."
      sudo rm -rf /var/lib/ollama/models
      REMOVED_STORES=1
    fi
    if [ "$REMOVED_STORES" = "1" ]; then
      echo -e "  ${GREEN}✓ Ollama models removed${NC}"
    fi

    # Remove Ollama user
    if id "ollama" &>/dev/null; then
      echo -e "  Removing ollama user..."
      sudo userdel -r ollama 2>/dev/null || true
      echo -e "  ${GREEN}✓ Ollama user removed${NC}"
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Everything removed successfully!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    SUCCESS=1
    ;;

  0)
    echo ""
    echo -e "${YELLOW}Cancelled.${NC}"
    echo ""
    ;;

  *)
    echo ""
    echo -e "${RED}Invalid choice. Cancelled.${NC}"
    echo ""
    ;;
esac

# --- Self-cleanup ---
# Deletes itself once removal actually succeeded. Cancel, an invalid choice or
# a failed step (set -e exits first) leave the file on disk so it can be run
# again. The content check means a piped run (`curl | bash`, where $0 is the
# shell itself) never deletes anything that is not this script.
SELF="$0"
if [ "$SUCCESS" = "1" ] && [ -f "$SELF" ] && head -n 6 "$SELF" | grep -q "Plankton Network Worker - .* Uninstall"; then
  rm -f -- "$SELF"
  echo -e "  ${GREEN}✓ Uninstaller removed itself${NC}"
  echo ""
fi
