#!/bin/bash
# gh-pick.sh "<combobox label substring>" "<option label substring>" ["<text to type to filter>"]
# Greenhouse react-select. Opens the combobox, optionally filters, then clicks the option.
export PATH=$PATH:/home/felixlin/zylos/bin
LBL="$1"; OPT="$2"; TYPE="${3:-}"
snap(){ zylos-browser snapshot -i 2>/dev/null; }
S=$(snap)
ref=$(printf '%s' "$S" | grep -F "combobox \"$LBL" | head -1 | sed -E 's/.*\[ref=(e[0-9]+)\].*/\1/')
[ -z "$ref" ] && { echo "NOFIND combobox: $LBL"; exit 1; }
# if already expanded, don't toggle it shut
printf '%s' "$S" | grep -F "combobox \"$LBL" | head -1 | grep -q '\[expanded\]' || zylos-browser click "$ref" >/dev/null 2>&1
sleep 1
if [ -n "$TYPE" ]; then
  ref=$(snap | grep -F "combobox \"$LBL" | head -1 | sed -E 's/.*\[ref=(e[0-9]+)\].*/\1/')
  zylos-browser fill "$ref" "$TYPE" >/dev/null 2>&1
  sleep 1
fi
oref=$(snap | grep -F "option \"$OPT" | head -1 | sed -E 's/.*\[ref=(e[0-9]+)\].*/\1/')
if [ -z "$oref" ]; then
  echo "NOFIND option: $OPT (combobox $LBL) — options visible:"; snap | grep -m 15 'option "'; exit 1
fi
zylos-browser click "$oref" >/dev/null 2>&1
sleep 1
snap | grep -F "combobox \"$LBL" | head -1
