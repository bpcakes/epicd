#!/bin/sh
set -eu
epicd_browser_dir=$(mktemp -d "${TMPDIR:-/tmp}/epicd-browser-check-XXXXXX")
cat vendor/toolchain.part-* | tar -xz -C "$epicd_browser_dir"
export EPICD_BROWSER_SOURCE_ROOT="$PWD"
export EPICD_PLAYWRIGHT_ROOT="$epicd_browser_dir/node_modules"
export EPICD_BROWSER_NODE="$epicd_browser_dir/node"
export EPICD_BROWSER_EXECUTABLE="$epicd_browser_dir/chrome-headless-shell-linux64/chrome-headless-shell"
export EPICD_BROWSER_OUTPUT="$epicd_browser_dir/results"
# An ordinary worker has no host database authority. Kernel validation supplies
# the declared URL after its independent fixture/grant admission.
exec "$EPICD_BROWSER_NODE" "$EPICD_PLAYWRIGHT_ROOT/playwright/cli.js" test --config playwright.config.cjs
