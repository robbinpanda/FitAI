#!/bin/sh
# First install only, after python3-venv and nginx have been installed.
# Run as root: sh install-private.sh /tmp/fitai-release.tar.gz
# Application stays in SERVER mode; SSH provides the encrypted transport.
set -eu
test "$(id -u)" = 0
archive=${1:?Supply the code-only release archive}
test -f "$archive"
if test -e /opt/fitai || test -e /etc/fitai.env; then
    echo 'Existing installation found; use the documented backup/update procedure.' >&2
    exit 1
fi
if ! id fitai >/dev/null 2>&1; then
    useradd --system --home /var/lib/fitai --shell /usr/sbin/nologin fitai
fi
install -d -o root -g root -m 755 /opt/fitai
install -d -o fitai -g fitai -m 700 /var/lib/fitai
tar -xzf "$archive" -C /opt/fitai
chown -R root:root /opt/fitai
python3 -m venv /opt/fitai/.venv
/opt/fitai/.venv/bin/pip install --disable-pip-version-check --index-url https://pypi.org/simple -r /opt/fitai/requirements-server.txt
umask 077
cat > /etc/fitai.env <<'ENV'
FITAI_MODE=server
FITAI_SSH_PREVIEW=1
FITAI_PUBLIC_ORIGIN=http://localhost:18765
FITAI_DATA_DIR=/var/lib/fitai
FITAI_PORT=8765
FITAI_TIMEOUT=90
FITAI_MAX_USERS=20
FITAI_USER_QUOTA_MB=512
FITAI_MODEL_ORIGINS=https://api.deepseek.com,https://api.openai.com
PYTHONUNBUFFERED=1
TZ=Asia/Shanghai
ENV
install -m 644 /opt/fitai/deploy/fitai.service /etc/systemd/system/fitai.service
install -d -m 755 /etc/systemd/system/fitai.service.d
cat > /etc/systemd/system/fitai.service.d/resources.conf <<'UNIT'
[Service]
MemoryHigh=512M
MemoryMax=768M
UNIT
systemctl daemon-reload
systemctl enable --now fitai
echo 'Installed. No public web listener. Registration remains closed until you set an invitation.'
