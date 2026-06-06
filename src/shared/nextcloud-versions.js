/**
 * Single source of truth for the Nextcloud server versions supported by the
 * playground. Consumed by both the build pipeline (scripts/) and the UI so the
 * two never drift.
 *
 * Each entry:
 * - `major`:   the Nextcloud major version, as a string (matches the manifest
 *              file name `nextcloud-${major}.json` and the bundle directory).
 * - `release`: the release id passed to scripts/fetch-nextcloud-release.sh,
 *              i.e. the `${release}.tar.bz2` name on download.nextcloud.com.
 * - `php`:     the php-wasm runtime version this release is built/tested against.
 * - `default`: exactly one entry should be `true`; it is the version the UI and
 *              `assets/manifests/latest.json` point at by default.
 */
export const NEXTCLOUD_VERSIONS = [
  { major: "30", release: "latest-30", php: "8.3", default: false },
  { major: "31", release: "latest-31", php: "8.3", default: true },
  { major: "32", release: "latest-32", php: "8.3", default: false },
];

/**
 * Return the default version entry (the one flagged `default: true`), falling
 * back to the first entry if none is flagged.
 */
export function defaultVersion() {
  return (
    NEXTCLOUD_VERSIONS.find((entry) => entry.default) || NEXTCLOUD_VERSIONS[0]
  );
}

/**
 * Return the version entry matching the given major (as a string), or
 * `undefined` if no such version is supported.
 */
export function findVersion(major) {
  return NEXTCLOUD_VERSIONS.find((entry) => entry.major === String(major));
}
