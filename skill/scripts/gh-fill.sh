#!/bin/bash
# gh-fill.sh <resume_pdf> [transcript_pdf]
# Fills the standard Greenhouse application block for Felix from the profile on file.
export PATH=$PATH:/home/felixlin/zylos/bin
P="$(dirname "$0")/gh-pick.sh"
ref(){ zylos-browser snapshot -i 2>/dev/null | grep -F "$1" | head -1 | sed -E 's/.*\[ref=(e[0-9]+)\].*/\1/'; }
zylos-browser fill "$(ref 'textbox "First Name"')" "Felix" >/dev/null
zylos-browser fill "$(ref 'textbox "Last Name"')" "Lin" >/dev/null
zylos-browser fill "$(ref 'textbox "Email"')" "felixl0808@gmail.com" >/dev/null
zylos-browser fill "$(ref 'textbox "Phone"')" "9499810389" >/dev/null
L=$(ref 'textbox "LinkedIn'); [ -n "$L" ] && zylos-browser fill "$L" "https://www.linkedin.com/in/felix-lin-52048b29a/" >/dev/null
"$P" "Country" "United States +1" >/dev/null
"$P" "Location (City)" "Irvine, California, United States" "Irvine" >/dev/null
"$P" "School" "Carnegie Mellon University" "Carnegie Mellon" >/dev/null
"$P" "Degree" "Bachelor's Degree" "Bachelor" >/dev/null
S=$(ref 'spinbutton "Start date year"'); [ -n "$S" ] && zylos-browser fill "$S" "2024" >/dev/null
E=$(ref 'spinbutton "End date year"');   [ -n "$E" ] && zylos-browser fill "$E" "2028" >/dev/null
echo "base fields done"
