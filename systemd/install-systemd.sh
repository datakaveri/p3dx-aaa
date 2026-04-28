#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo:"
  echo "  sudo ./systemd/install-systemd.sh [--now]"
  exit 1
fi

SYSTEMD_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DST="/etc/systemd/system"
ENV_DIR="/etc/p3dx-aaa"
ENV_FILE="${ENV_DIR}/keycloak.env"
NOW_MODE="${1:-}"

# Ensure binary output dir exists
mkdir -p /home/azureuser/bin
chown azureuser:azureuser /home/azureuser/bin

echo "Installing p3dx platform systemd units..."
install -m 0644 "${SYSTEMD_SRC}/immudb-container.service"       "${SYSTEMD_DST}/immudb-container.service"
install -m 0644 "${SYSTEMD_SRC}/keycloak-dev.service"           "${SYSTEMD_DST}/keycloak-dev.service"
install -m 0644 "${SYSTEMD_SRC}/p3dx-aaa-auth-backend.service"  "${SYSTEMD_DST}/p3dx-aaa-auth-backend.service"
install -m 0644 "${SYSTEMD_SRC}/p3dx-apd.service"               "${SYSTEMD_DST}/p3dx-apd.service"
install -m 0644 "${SYSTEMD_SRC}/p3dx-top.service"               "${SYSTEMD_DST}/p3dx-top.service"
install -m 0644 "${SYSTEMD_SRC}/p3dx-auth-ui.service"           "${SYSTEMD_DST}/p3dx-auth-ui.service"

mkdir -p "${ENV_DIR}"
chmod 700 "${ENV_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "WARNING: ${ENV_FILE} not found."
  echo "Create it before starting keycloak-dev.service. Required keys: KC_DB_URL, KC_DB_USERNAME, KC_DB_PASSWORD"
else
  chmod 600 "${ENV_FILE}"
  echo "Found existing ${ENV_FILE}."
fi

systemctl daemon-reload
systemctl enable immudb-container.service
systemctl enable keycloak-dev.service
systemctl enable p3dx-aaa-auth-backend.service
systemctl enable p3dx-apd.service
systemctl enable p3dx-top.service
systemctl enable p3dx-auth-ui.service

if [[ "${NOW_MODE}" == "--now" ]]; then
  systemctl start immudb-container.service
  systemctl start keycloak-dev.service
  systemctl start p3dx-aaa-auth-backend.service
  systemctl start p3dx-apd.service
  systemctl start p3dx-top.service
  systemctl start p3dx-auth-ui.service
fi

echo
echo "Install complete. All 6 services enabled for boot."
echo
echo "  immudb         →  port 3322"
echo "  keycloak       →  port 8080"
echo "  p3dx-aaa       →  port 3001"
echo "  p3dx-apd       →  port 8082"
echo "  TOP            →  port 8085"
echo "  p3dx-auth-ui   →  port 5173"
echo
echo "Useful commands:"
echo "  sudo systemctl status immudb-container keycloak-dev p3dx-aaa-auth-backend p3dx-apd p3dx-top p3dx-auth-ui"
echo "  sudo journalctl -u p3dx-aaa-auth-backend -u p3dx-apd -u p3dx-top -u p3dx-auth-ui -f"
