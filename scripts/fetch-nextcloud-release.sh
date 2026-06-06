#!/bin/sh

set -eu

# Download + cache a Nextcloud release tarball and extract it. Prints the path
# to the extracted "nextcloud/" source directory on stdout; all progress and
# log output goes to stderr.
#
# Usage:
#   ./scripts/fetch-nextcloud-release.sh [release]
#   NC_RELEASE=latest-31 ./scripts/fetch-nextcloud-release.sh
#
# `release` is a Nextcloud release id such as "latest-31" (the basename of the
# `${release}.tar.bz2` archive published on download.nextcloud.com).

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

RELEASE=${1:-${NC_RELEASE:-latest-31}}
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/nextcloud-source"}
TARBALL="$CACHE_DIR/${RELEASE}.tar.bz2"
EXTRACT_DIR="$CACHE_DIR/${RELEASE}"
SOURCE_DIR="$EXTRACT_DIR/nextcloud"
DOWNLOAD_URL="https://download.nextcloud.com/server/releases/${RELEASE}.tar.bz2"

mkdir -p "$CACHE_DIR"

# Download (skip if already cached and non-empty).
if [ -s "$TARBALL" ]; then
  echo "Using cached tarball: $TARBALL" >&2
else
  echo "Downloading $DOWNLOAD_URL ..." >&2
  curl -fSL --retry 3 -o "$TARBALL" "$DOWNLOAD_URL" >&2
  echo "Downloaded: $TARBALL" >&2
fi

# Extract (skip if already extracted). The tarball contains a top-level
# "nextcloud/" directory, so it lands at $EXTRACT_DIR/nextcloud.
if [ -d "$SOURCE_DIR" ]; then
  echo "Using cached extraction: $SOURCE_DIR" >&2
else
  echo "Extracting $TARBALL -> $EXTRACT_DIR ..." >&2
  mkdir -p "$EXTRACT_DIR"
  tar -xjf "$TARBALL" -C "$EXTRACT_DIR" >&2
  echo "Extracted: $SOURCE_DIR" >&2
fi

printf '%s\n' "$SOURCE_DIR"
