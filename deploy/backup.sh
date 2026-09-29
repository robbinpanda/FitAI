#!/bin/sh
# Run as root. Stop briefly for a consistent backup of all databases AND photos.
set -eu
destination=${1:-/var/backups/fitai}
install -d -m 700 "$destination"
umask 077
archive="$destination/fitai-$(date +%Y%m%d-%H%M%S).tar.gz"
systemctl stop fitai
trap 'systemctl start fitai' EXIT HUP INT TERM
tar -czf "$archive" -C /var/lib fitai
echo "Backup saved: $archive"
