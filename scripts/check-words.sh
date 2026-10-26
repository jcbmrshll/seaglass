#!/bin/sh
# Fails if any tracked file names, in its path or its contents, a word this project
# must not mention: seaglass stands alone. The word is split here so this script
# doesn't trip over itself.
set -u
word="sl""ick"
found=0
if git ls-files | grep -i -- "$word"; then
  found=1
fi
if git grep -n -i -I -- "$word"; then
  found=1
fi
if [ "$found" -ne 0 ]; then
  echo "error: the tree mentions '$word' (above)" >&2
  exit 1
fi
echo "ok: no mention of '$word'"
