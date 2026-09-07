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
# Anchored matching (2026-09-07: unanchored "male" picked "Female", veteran
# picked the wrong option). Order: whole-label match, then label-anchored
# regex, then substring as a last resort (flagged so the applier re-checks).
labels=$(echo "$opts" | sed -E 's/^.*option "((\\.|[^"\\])*)".*$/\1/')
m=$(paste -d'\t' <(echo "$labels") <(echo "$opts") | awk -F'\t' -v p="$pat" 'BEGIN{IGNORECASE=1} tolower($1)==tolower(p){print $2; exit}')
[ -z "$m" ] && m=$(paste -d'\t' <(echo "$labels") <(echo "$opts") | awk -F'\t' -v p="$pat" 'BEGIN{IGNORECASE=1} $1 ~ ("^(" p ")$"){print $2; exit}')
if [ -z "$m" ]; then m=$(echo "$opts" | grep -iE "$pat" | head -1); [ -n "$m" ] && echo "  (substring match only — verify) "; fi
mref=$(echo "$m" | grep -o 'ref=e[0-9]*' | cut -d= -f2)
if [ -z "$mref" ]; then echo "NO MATCH '$pat'"; echo "$opts"|head -25; agent-browser press Escape >/dev/null 2>&1; exit 1; fi
agent-browser click "@$mref" >/dev/null 2>&1; sleep 1
echo "  -> $m"
