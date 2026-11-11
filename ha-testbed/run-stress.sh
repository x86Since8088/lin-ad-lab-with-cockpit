#!/usr/bin/env bash
# One full pass of the §12 stress program on the testbed (sequential; ~1 day).
cd "$(dirname "$(readlink -f "$0")")"
R=${1:-stress-1}
for row in "S1 50" "S10 100" "S2 7200" "S3" "S5 200" "S6 20" "S7" "S9 10" "S4 10000"; do
  echo "=== $(date '+%F %T') $row"
  python3 -u stress.py $row --run "$R" 2>&1 | grep -E 'RESULT|Traceback|Error|cycle '
done
echo "=== $(date '+%F %T') pass done"; python3 stress.py report "$R"
