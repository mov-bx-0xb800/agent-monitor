#!/bin/bash
# One bounded sleeping process per native chat; no polling or detached daemon.
set -u
node_path="$1"
cache_root="$2"
runtime_dir="${BASH_SOURCE[0]%/*}"
identity="$("$node_path" "$runtime_dir/claude-wake.js" prepare "$cache_root" "$$")"
[[ "$identity" =~ ^([a-f0-9]{20})\ ([a-f0-9-]{36})$ ]] || exit 0
sid="${BASH_REMATCH[1]}"
token="${BASH_REMATCH[2]}"
cleanup() { "$node_path" "$runtime_dir/claude-wake.js" cleanup "$cache_root" "$sid" "$token"; }
trap cleanup EXIT
trap 'exit 0' HUP INT TERM
exec 3<>"$cache_root/wake/$sid.pipe" || exit 0
"$node_path" "$runtime_dir/claude-wake.js" ready "$cache_root" "$sid" "$token" || exit 0
request=''
if IFS= read -r -t 3600 -u 3 request; then
  if [[ "$request" =~ ^[a-f0-9-]{36}$ ]]; then
    "$node_path" "$runtime_dir/claude-wake.js" deliver "$cache_root" "$sid" "$token" "$request"
    exit "$?"
  fi
fi
exit 0
