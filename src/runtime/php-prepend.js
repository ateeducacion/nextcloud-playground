import { NEXTCLOUD_ROOT } from "./bootstrap-paths.js";

/**
 * PHP `auto_prepend_file` content, executed before every Nextcloud request and
 * before every occ command.
 *
 * The stock @php-wasm PHP build is compiled with `--disable-posix`, but
 * Nextcloud lists posix as REQUIRED and calls several posix_* functions
 * WITHOUT function_exists() guards (e.g. in CheckSetupController / base.php /
 * console.php), which would otherwise be a fatal "Call to undefined function"
 * under WASM. We stub the posix surface Nextcloud touches with a fake
 * "www-data" user (uid 33). See docs/feasibility-spike.md.
 *
 * Kept in its own module (only pure path constants imported) so it can be unit
 * tested without pulling in the browser-only bootstrap dependency chain.
 */
export function buildPhpPrepend() {
  return `<?php
// ── posix polyfill (build is --disable-posix; Nextcloud requires posix) ──────
if (!function_exists('posix_getuid')) {
    function posix_getuid() { return 33; }
}
if (!function_exists('posix_geteuid')) {
    function posix_geteuid() { return 33; }
}
if (!function_exists('posix_getgid')) {
    function posix_getgid() { return 33; }
}
if (!function_exists('posix_getegid')) {
    function posix_getegid() { return 33; }
}
if (!function_exists('posix_getpid')) {
    function posix_getpid() { return 42; }
}
if (!function_exists('posix_getppid')) {
    function posix_getppid() { return 1; }
}
if (!function_exists('posix_getpwuid')) {
    function posix_getpwuid($uid) {
        return [
            'name' => 'www-data', 'passwd' => 'x', 'uid' => (int) $uid,
            'gid' => 33, 'gecos' => 'www-data', 'dir' => '/var/www',
            'shell' => '/usr/sbin/nologin',
        ];
    }
}
if (!function_exists('posix_getpwnam')) {
    function posix_getpwnam($name) {
        return [
            'name' => $name, 'passwd' => 'x', 'uid' => 33, 'gid' => 33,
            'gecos' => $name, 'dir' => '/var/www', 'shell' => '/usr/sbin/nologin',
        ];
    }
}
if (!function_exists('posix_getgrgid')) {
    function posix_getgrgid($gid) {
        return ['name' => 'www-data', 'passwd' => 'x', 'gid' => (int) $gid, 'members' => ['www-data']];
    }
}
if (!function_exists('posix_getgrnam')) {
    function posix_getgrnam($name) {
        return ['name' => $name, 'passwd' => 'x', 'gid' => 33, 'members' => [$name]];
    }
}
if (!function_exists('posix_getgroups')) {
    function posix_getgroups() { return [33]; }
}
if (!function_exists('posix_kill')) {
    function posix_kill($pid, $sig) { return true; }
}
if (!function_exists('posix_setuid')) {
    function posix_setuid($uid) { return true; }
}
if (!function_exists('posix_setgid')) {
    function posix_setgid($gid) { return true; }
}
if (!function_exists('posix_isatty')) {
    function posix_isatty($fd) { return false; }
}
if (!function_exists('posix_uname')) {
    function posix_uname() {
        return [
            'sysname' => 'Linux', 'nodename' => 'nextcloud-playground',
            'release' => '0.0.0-wasm', 'version' => '#1 WASM', 'machine' => 'wasm32',
        ];
    }
}
if (!function_exists('posix_errno')) {
    function posix_errno() { return 0; }
}
if (!function_exists('posix_strerror')) {
    function posix_strerror($errno) { return ''; }
}

// ── flock-free session handler ───────────────────────────────────────────────
// PHP's native "files" session handler locks each session file with flock(),
// which blocks forever (or fails) under Emscripten. Without persisted sessions
// the CSRF token generated on the login page never matches on POST, so every
// login bounces back to the form. The playground is single-user / single-
// threaded, so we replace the handler with plain file I/O and no locking.
if (!class_exists('PlaygroundSessionHandler')) {
    class PlaygroundSessionHandler implements SessionHandlerInterface {
        private string $dir;
        public function open(string $path, string $name): bool {
            $this->dir = $path !== '' ? $path : sys_get_temp_dir();
            if (!is_dir($this->dir)) { @mkdir($this->dir, 0777, true); }
            return true;
        }
        public function close(): bool { return true; }
        #[ReturnTypeWillChange]
        public function read(string $id): string {
            $f = $this->file($id);
            return is_file($f) ? (string) @file_get_contents($f) : '';
        }
        public function write(string $id, string $data): bool {
            return @file_put_contents($this->file($id), $data) !== false;
        }
        public function destroy(string $id): bool {
            $f = $this->file($id);
            if (is_file($f)) { @unlink($f); }
            return true;
        }
        #[ReturnTypeWillChange]
        public function gc(int $max): int { return 0; }
        private function file(string $id): string {
            return rtrim($this->dir, '/') . '/psess_' . preg_replace('/[^A-Za-z0-9_-]/', '', $id);
        }
    }
}
if (session_status() === PHP_SESSION_NONE) {
    @session_set_save_handler(new PlaygroundSessionHandler(), true);
}

// ── $_SERVER defaults so CLI (occ) and bare-script runs behave ──────────────
if (empty($_SERVER['DOCUMENT_ROOT'])) { $_SERVER['DOCUMENT_ROOT'] = '${NEXTCLOUD_ROOT}'; }
if (empty($_SERVER['SCRIPT_FILENAME'])) { $_SERVER['SCRIPT_FILENAME'] = $_SERVER['DOCUMENT_ROOT'] . '/index.php'; }
`;
}
