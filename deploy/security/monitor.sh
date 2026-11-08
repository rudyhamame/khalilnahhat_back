#!/usr/bin/env bash
set -euo pipefail
failed=0
free_kb=$(df -Pk / | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt 2097152 ]; then echo 'ALERT Khalil OVH disk has less than 2 GiB free.' >&2; failed=1; fi
for url in https://djkhalilnahhat.ca/ https://api.djkhalilnahhat.ca/api/ready https://stems.djkhalilnahhat.ca/health http://127.0.0.1:20243/ready; do
  if ! curl -fSs --max-time 15 --output /dev/null "$url"; then echo "ALERT Khalil endpoint failed: $url" >&2; failed=1; fi
done
if ! find /srv/rh/khalil-security/backups -maxdepth 1 -type f -name 'khalil-*.cms' -mmin -1800 -print -quit | grep -q .; then
  echo 'ALERT Khalil encrypted backup is missing or older than 30 hours.' >&2; failed=1
fi
exit "$failed"
