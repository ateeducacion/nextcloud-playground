<?php
/**
 * Feasibility-spike posix polyfill (auto_prepend_file).
 *
 * The stock @php-wasm PHP build is compiled with `--disable-posix`, but
 * Nextcloud lists posix as REQUIRED and calls several posix_* functions
 * WITHOUT function_exists() guards (e.g. in CheckSetupController / base.php),
 * which would be a fatal "Call to undefined function" under WASM.
 *
 * We stub the posix surface Nextcloud touches with a fake "www-data" user.
 */

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
            'name'   => 'www-data',
            'passwd' => 'x',
            'uid'    => (int) $uid,
            'gid'    => 33,
            'gecos'  => 'www-data',
            'dir'    => '/var/www',
            'shell'  => '/usr/sbin/nologin',
        ];
    }
}
if (!function_exists('posix_getpwnam')) {
    function posix_getpwnam($name) {
        return [
            'name'   => $name,
            'passwd' => 'x',
            'uid'    => 33,
            'gid'    => 33,
            'gecos'  => $name,
            'dir'    => '/var/www',
            'shell'  => '/usr/sbin/nologin',
        ];
    }
}
if (!function_exists('posix_getgrgid')) {
    function posix_getgrgid($gid) {
        return [
            'name'    => 'www-data',
            'passwd'  => 'x',
            'gid'     => (int) $gid,
            'members' => ['www-data'],
        ];
    }
}
if (!function_exists('posix_getgrnam')) {
    function posix_getgrnam($name) {
        return [
            'name'    => $name,
            'passwd'  => 'x',
            'gid'     => 33,
            'members' => [$name],
        ];
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
            'sysname'  => 'Linux',
            'nodename' => 'nextcloud-playground',
            'release'  => '0.0.0-wasm',
            'version'  => '#1 WASM',
            'machine'  => 'wasm32',
        ];
    }
}
if (!function_exists('posix_errno')) {
    function posix_errno() { return 0; }
}
if (!function_exists('posix_strerror')) {
    function posix_strerror($errno) { return ''; }
}
