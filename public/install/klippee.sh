#!/bin/sh
set -eu

# Compatibility bootstrap for existing install links. The installed CLI and all
# sync behavior live in klippee.py; this script only downloads and starts it.
official_base_url="https://klippee.xyz"
base_url="${KLIPPEE_INSTALL_BASE_URL:-$official_base_url}"
base_url="${base_url%/}"
python_bin="${KLIPPEE_PYTHON:-python3}"

fail() {
  echo "klippee: $*" >&2
  exit 1
}

case "$base_url" in
  https://*)
    curl_protocol="=https"
    ;;
  http://127.0.0.1:*|http://localhost:*)
    [ "${KLIPPEE_ALLOW_INSECURE_INSTALL:-0}" = "1" ] || \
      fail "an HTTP install source is allowed only for an explicitly enabled loopback test server"
    curl_protocol="=http"
    ;;
  *)
    fail "install source must be HTTPS (set KLIPPEE_INSTALL_BASE_URL for a trusted self-hosted mirror)"
    ;;
esac

case "$base_url" in
  *\?*|*\#*|*://*@*)
    fail "install source must not contain credentials, a query, or a fragment"
    ;;
esac

command -v "$python_bin" >/dev/null 2>&1 || {
  echo "klippee: Python 3 is required" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "klippee: curl is required" >&2
  exit 1
}

umask 077
temporary="$(mktemp "${TMPDIR:-/tmp}/klippee-install.XXXXXX")" || \
  fail "could not create a secure temporary file"
trap 'rm -f "$temporary"' EXIT INT TERM
curl --disable --fail --silent --show-error \
  --proto "$curl_protocol" \
  --proto-redir "$curl_protocol" \
  --max-redirs 0 \
  --max-filesize 2000000 \
  "$base_url/install/klippee.py" \
  -o "$temporary"
"$python_bin" "$temporary" install
