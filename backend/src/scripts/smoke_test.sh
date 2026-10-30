#!/usr/bin/env bash
# usage: scripts/smoke_test.sh https://app.example.com
B=${1:-http://localhost:9003}; fail=0
chk(){ code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "${@:2}"); [ "$code" = "$1" ] && echo "PASS $1 ${*: -1}" || { echo "FAIL want $1 got $code ${*: -1}"; fail=1; }; }
chk 200 "$B/health"; chk 200 "$B/ready"; chk 200 "$B/"; chk 200 "$B/api/symbols"
chk 404 "$B/api/nope"; chk 400 "$B/api/chart?symbol=NSE:NIFTY50-INDEX&resolution=abc"
chk 401 -X POST -H 'content-type: application/json' -d '{}' "$B/api/scanner/stop"
curl -s -I "$B/health" | grep -qi strict-transport-security && echo "PASS HSTS" || { echo "FAIL HSTS missing"; fail=1; }
exit $fail