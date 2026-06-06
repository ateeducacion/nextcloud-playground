#!/bin/sh

set -eu

# Build ONE trimmed, WASM-patched Nextcloud ZIP bundle + manifest for a single
# major version.
#
# Inputs (env):
#   NC_RELEASE  release id to fetch (default "latest-33")
#   NC_MAJOR    Nextcloud major version (default "33")
#
# Outputs:
#   assets/nextcloud/nextcloud-${MAJOR}/nextcloud-core-${MAJOR}.zip
#   assets/manifests/nextcloud-${MAJOR}.json
#   assets/manifests/latest.json (only when MAJOR is the default version per
#   src/shared/nextcloud-versions.js)
#
# Unlike a FacturaScripts checkout, Nextcloud release tarballs ship pre-built:
# vendor/ (3rdparty/), compiled JS (dist/) and l10n are already present, so we
# do NOT run composer or npm here. We only stage, WASM-patch, trim and zip.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

RELEASE=${NC_RELEASE:-latest-33}
MAJOR=${NC_MAJOR:-33}

WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-nextcloud"}
STAGE_DIR="$WORK_DIR/stage"
NC_STAGE="$STAGE_DIR/nextcloud"
DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/nextcloud/nextcloud-${MAJOR}"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
BUNDLE_PATH="$DIST_DIR/nextcloud-core-${MAJOR}.zip"
MANIFEST_PATH="$MANIFEST_DIR/nextcloud-${MAJOR}.json"

# 1. Fetch the release source (downloads + extracts, prints the source dir).
echo "Fetching Nextcloud release $RELEASE ..." >&2
SOURCE_DIR=$("$SCRIPT_DIR/fetch-nextcloud-release.sh" "$RELEASE")
echo "Source dir: $SOURCE_DIR" >&2

# 2. Stage: fresh copy of the source into the stage dir.
rm -rf "$STAGE_DIR"
mkdir -p "$NC_STAGE" "$DIST_DIR" "$MANIFEST_DIR"
echo "Staging source -> $NC_STAGE ..." >&2
cp -R "$SOURCE_DIR"/. "$NC_STAGE"

# 3. Apply WASM patches (all gated on PHP_SAPI so they no-op on real servers).
#    Each patch is verified with grep; a missing target is a hard failure.
echo "Applying WASM patches ..." >&2

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

# (a) lib/base.php — treat occ (no REQUEST_URI) as CLI under the wasm SAPI.
apply_patch "lib/base.php" \
  "s/self::\\\$CLI = \\(php_sapi_name\\(\\) == 'cli'\\);/self::\\\$CLI = (php_sapi_name() == 'cli') || (PHP_SAPI === 'wasm' \\&\\& empty(\\\$_SERVER['REQUEST_URI']));/" \
  "(PHP_SAPI === 'wasm' && empty(\$_SERVER['REQUEST_URI']))"

# (b) lib/private/Config.php — skip unreliable shared flock under wasm.
apply_patch "lib/private/Config.php" \
  "s/if \\(!flock\\(\\\$filePointer, LOCK_SH\\)\\) \\{/if (!flock(\\\$filePointer, LOCK_SH) \\&\\& PHP_SAPI !== 'wasm') {/" \
  "if (!flock(\$filePointer, LOCK_SH) && PHP_SAPI !== 'wasm') {"

# (c) lib/private/Config.php — skip unreliable exclusive flock under wasm.
apply_patch "lib/private/Config.php" \
  "s/if \\(!flock\\(\\\$filePointer, LOCK_EX\\)\\) \\{/if (!flock(\\\$filePointer, LOCK_EX) \\&\\& PHP_SAPI !== 'wasm') {/" \
  "if (!flock(\$filePointer, LOCK_EX) && PHP_SAPI !== 'wasm') {"

# (d) console.php — skip the posix uid/owner mismatch refusal under wasm.
apply_patch "console.php" \
  "s/if \\(\\\$user !== \\\$configUser\\) \\{/if (\\\$user !== \\\$configUser \\&\\& PHP_SAPI !== 'wasm') {/" \
  "if (\$user !== \$configUser && PHP_SAPI !== 'wasm') {"

# (e) lib/private/Avatar/Avatar.php — guard imagettfbbox returning false.
apply_patch "lib/private/Avatar/Avatar.php" \
  "s/(\\\$box = imagettfbbox\\(\\\$size, \\\$angle, \\\$font, \\\$text\\);)/\$1\\n\\t\\tif (!is_array(\\\$box)) { return [0, (int)\\\$size]; }/" \
  "if (!is_array(\$box)) { return [0, (int)\$size]; }"

# 4. Trim aggressively — the browser holds the whole bundle in MEMFS.
echo "Stage size before trim: $(du -sh "$NC_STAGE" | cut -f1)" >&2

# Drop test/dev directories anywhere in the tree.
for d in tests Test cypress screenshots; do
  find "$NC_STAGE" -type d -name "$d" -prune -exec rm -rf {} + 2>/dev/null || true
done

# Drop source maps and VCS/dev metadata.
find "$NC_STAGE" -type f -name "*.map" -delete 2>/dev/null || true
rm -rf "$NC_STAGE/.git" "$NC_STAGE/.github" "$NC_STAGE/.tx"

# Remove heavy optional shipped apps not needed for the demo.
REMOVE_APPS="photos suspicious_login files_pdfviewer recommendations \
bruteforcesettings related_resources user_ldap circles privacy app_api \
logreader password_policy files_downloadlimit twofactor_totp \
twofactor_nextcloud_notification weather_status support admin_audit \
encryption federation files_external sharebymail updatenotification \
survey_client user_status contactsinteraction cloud_federation_api \
files_reminders testing"
for app in $REMOVE_APPS; do
  rm -rf "$NC_STAGE/apps/$app"
done

echo "Stage size after trim:  $(du -sh "$NC_STAGE" | cut -f1)" >&2

# 5. Zip with the top-level "nextcloud/" prefix (the loader strips it).
echo "Creating ZIP bundle: $BUNDLE_PATH ..." >&2
rm -f "$BUNDLE_PATH"
(cd "$STAGE_DIR" && zip -qr "$BUNDLE_PATH" nextcloud)

# 6. Read the exact release version from version.php (fallback to MAJOR).
RELEASE_VERSION=$(php -r 'preg_match("/OC_VersionString\s*=\s*.([\d.]+)/", file_get_contents($argv[1]), $m); echo $m[1] ?? "";' "$NC_STAGE/version.php")
if [ -z "$RELEASE_VERSION" ]; then
  RELEASE_VERSION="$MAJOR"
fi
echo "Release version: $RELEASE_VERSION" >&2

FILE_COUNT=$(find "$NC_STAGE" -type f | wc -l | tr -d ' ')
echo "Bundle file count: $FILE_COUNT" >&2

# 7. Generate the manifest with the shared node script.
node "$SCRIPT_DIR/generate-manifest.mjs" \
  --channel browser \
  --manifest "$MANIFEST_PATH" \
  --release "$RELEASE_VERSION" \
  --sourceRepository "https://download.nextcloud.com/server/releases/${RELEASE}.tar.bz2" \
  --sourceBranch "$RELEASE" \
  --sourceCommit "$RELEASE_VERSION" \
  --bundle "$BUNDLE_PATH" \
  --fileCount "$FILE_COUNT"

# 8. The default major (per src/shared/nextcloud-versions.js) also publishes
#    latest.json.
DEFAULT_MAJOR=$(node -e "import('$REPO_DIR/src/shared/nextcloud-versions.js').then(m=>process.stdout.write(m.defaultVersion().major))" 2>/dev/null || echo "33")
if [ "$MAJOR" = "$DEFAULT_MAJOR" ]; then
  cp "$MANIFEST_PATH" "$MANIFEST_DIR/latest.json"
  echo "Copied manifest to $MANIFEST_DIR/latest.json" >&2
fi

# 9. Report.
echo "Bundle written to:   $BUNDLE_PATH" >&2
echo "Manifest written to: $MANIFEST_PATH" >&2
