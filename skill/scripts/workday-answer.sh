#!/bin/bash
# usage: wdq.sh <1-based question index among form dropdown buttons> <option regex>
# Re-snapshots with all dropdowns closed so refs are fresh, then selects.
idx="$1"; pat="$2"
agent-browser press Escape >/dev/null 2>&1; sleep 1
snap=$(~/zylos/bin/zylos-browser snapshot -i 2>&1)
# form dropdown buttons = lines between "Back to Job Posting" and "Back"/"Save and Continue"
list=$(echo "$snap" | awk '/Back to Job Posting/{f=1;next} /button "Back"|button "Save and Continue"/{f=0} f' | grep -E '^- (button|textbox)')
target=$(echo "$list" | sed -n "${idx}p")
ref=$(echo "$target" | grep -o 'ref=e[0-9]*' | cut -d= -f2)
if [ -z "$ref" ]; then echo "NO BUTTON at index $idx"; echo "$list"; exit 1; fi
echo "target[$idx]: $target"
agent-browser click "@$ref" >/dev/null 2>&1; sleep 2
opts=$(~/zylos/bin/zylos-browser snapshot -i 2>&1 | grep -i 'option "')
m=$(echo "$opts" | grep -iE "$pat" | head -1)
mref=$(echo "$m" | grep -o 'ref=e[0-9]*' | cut -d= -f2)
if [ -z "$mref" ]; then echo "NO MATCH '$pat'"; echo "$opts"|head -25; agent-browser press Escape >/dev/null 2>&1; exit 1; fi
agent-browser click "@$mref" >/dev/null 2>&1; sleep 1
echo "  -> $m"
