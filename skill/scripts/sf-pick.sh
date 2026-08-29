#!/bin/bash
# SuccessFactors (career4.successfactors.com) picklist selector.
# usage: sf-pick.sh <input-element-id> <exact option text>
# SF picklists are <input role=combobox> backed by a popup list; typing alone
# does NOT commit — you must click the option row.
id="$1"; want="$2"
agent-browser click "[id=\"$id\"]" >/dev/null 2>&1; sleep 1
agent-browser fill "[id=\"$id\"]" "$want" >/dev/null 2>&1; sleep 3
ref=$(~/zylos/bin/zylos-browser snapshot -i 2>&1 | grep -iE "option \"$want\"( \[|$)" | head -1 | grep -o 'ref=e[0-9]*' | cut -d= -f2)
if [ -z "$ref" ]; then
  ref=$(~/zylos/bin/zylos-browser snapshot -i 2>&1 | grep -iE "option \".*$want" | head -1 | grep -o 'ref=e[0-9]*' | cut -d= -f2)
fi
if [ -z "$ref" ]; then
  echo "MISS $id '$want' — options:"
  agent-browser eval "Array.from(document.querySelectorAll('[role=option]')).map(e=>e.innerText.trim()).slice(0,40).join(' ~ ')" 2>&1 | tail -1
  agent-browser press Escape >/dev/null 2>&1
  exit 1
fi
agent-browser click "@$ref" >/dev/null 2>&1; sleep 1
agent-browser press Escape >/dev/null 2>&1; sleep 1
echo "$id -> $(agent-browser eval "document.querySelector('[id=\"$id\"]').value" 2>&1|tail -1)"
