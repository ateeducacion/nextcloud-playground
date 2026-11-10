#!/bin/sh
set -eu

# Apply the WASM compatibility patches to a staged Nextcloud tree.
#
# Usage: scripts/apply-wasm-patches.sh <nextcloud-stage-dir>
#
# Every patch no-ops on real servers (most are gated on PHP_SAPI; the others
# guard a failure only php-wasm hits), and each one is verified with grep: a
# missing target or marker is a hard failure, so a new Nextcloud release that
# moves code breaks the build instead of shipping a silently unpatched core.
# Called from scripts/build-nextcloud-bundle.sh.

NC_STAGE=${1:?usage: apply-wasm-patches.sh <nextcloud-stage-dir>}

apply_patch() {
  # apply_patch <file> <perl-expr> <verify-substring>
  file="$1"
  expr="$2"
  needle="$3"
  if [ ! -f "$NC_STAGE/$file" ]; then
    echo "ERROR: patch target not found: $file" >&2
    exit 1
  fi
  perl -0pi -e "$expr" "$NC_STAGE/$file"
  if ! grep -qF "$needle" "$NC_STAGE/$file"; then
    echo "ERROR: patch did not apply (marker missing) in $file" >&2
    exit 1
  fi
  echo "  patched $file" >&2
}

# The playground's PHP reports the SAPI name `uwsgi` while OPcache is on (the
# default; php-src <= 8.4 only starts OPcache for whitelisted SAPI names) and
# `wasm` with `?opcache=0`. Keep this list in sync with
# OPCACHE_SAPI_NAME in src/runtime/php-loader.js. See docs/KNOWN-ISSUES.md#opcache.
# (a) class OC — treat occ (no REQUEST_URI) as CLI under the playground SAPIs.
#     Nextcloud <= 34 defines class OC in lib/base.php with `== 'cli'`;
#     Nextcloud 35 moved it to lib/OC.php (base.php only requires it) and uses
#     `=== 'cli'`. Patch whichever file holds the class, keeping its operator.
OC_CLASS_FILE=lib/base.php
if [ -f "$NC_STAGE/lib/OC.php" ]; then
  OC_CLASS_FILE=lib/OC.php
fi
apply_patch "$OC_CLASS_FILE" \
  "s/self::\\\$CLI = \\(php_sapi_name\\(\\) (===?) 'cli'\\);/self::\\\$CLI = (php_sapi_name() \$1 'cli') || (in_array(PHP_SAPI, ['wasm', 'uwsgi'], true) \\&\\& empty(\\\$_SERVER['REQUEST_URI']));/" \
  "(in_array(PHP_SAPI, ['wasm', 'uwsgi'], true) && empty(\$_SERVER['REQUEST_URI']))"

# (b) lib/private/Config.php — skip unreliable shared flock under the playground SAPIs.
apply_patch "lib/private/Config.php" \
  "s/if \\(!flock\\(\\\$filePointer, LOCK_SH\\)\\) \\{/if (!flock(\\\$filePointer, LOCK_SH) \\&\\& !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {/" \
  "if (!flock(\$filePointer, LOCK_SH) && !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {"

# (c) lib/private/Config.php — skip unreliable exclusive flock under the playground SAPIs.
apply_patch "lib/private/Config.php" \
  "s/if \\(!flock\\(\\\$filePointer, LOCK_EX\\)\\) \\{/if (!flock(\\\$filePointer, LOCK_EX) \\&\\& !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {/" \
  "if (!flock(\$filePointer, LOCK_EX) && !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {"

# (d) console.php — skip the posix uid/owner mismatch refusal under the playground SAPIs.
apply_patch "console.php" \
  "s/if \\(\\\$user !== \\\$configUser\\) \\{/if (\\\$user !== \\\$configUser \\&\\& !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {/" \
  "if (\$user !== \$configUser && !in_array(PHP_SAPI, ['wasm', 'uwsgi'], true)) {"

# (e) lib/private/Avatar/Avatar.php — guard imagettfbbox returning false.
apply_patch "lib/private/Avatar/Avatar.php" \
  "s/(\\\$box = imagettfbbox\\(\\\$size, \\\$angle, \\\$font, \\\$text\\);)/\$1\\n\\t\\tif (!is_array(\\\$box)) { return [0, (int)\\\$size]; }/" \
  "if (!is_array(\$box)) { return [0, (int)\$size]; }"

# (f) lib/private/Security/Hasher.php — Nextcloud >= 35 maps the hash algorithm
#     with a `match` whose arms name PASSWORD_ARGON2ID / PASSWORD_ARGON2I
#     unconditionally. php-wasm is built without argon2, so the constants are
#     undefined and `occ maintenance:install` dies hashing the admin password.
#     Use the constants' literal values ('argon2id', 'argon2i'): identical on
#     servers that have argon2, and safe where it is missing. Older majors have
#     no such match and are skipped.
HASHER=lib/private/Security/Hasher.php
if [ -f "$NC_STAGE/$HASHER" ] && grep -qF "PASSWORD_ARGON2ID => 3," "$NC_STAGE/$HASHER"; then
  apply_patch "$HASHER" \
    "s/PASSWORD_ARGON2ID => 3,/'argon2id' => 3,/; s/PASSWORD_ARGON2I => 2,/'argon2i' => 2,/" \
    "'argon2i' => 2,"
fi
