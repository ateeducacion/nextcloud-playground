import { NEXTCLOUD_ROOT } from "./bootstrap-paths.js";

const escapePhp = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

/**
 * PHP that establishes a logged-in Nextcloud session server-side, bypassing the
 * login form (and its CSRF token, which is awkward to round-trip in the
 * playground). It is executed via php.request() so the compat layer captures
 * the Set-Cookie session cookie into its jar; subsequent page requests then
 * carry it and Nextcloud sees an authenticated user.
 *
 * Mirrors the autologin approach of the Moodle / Omeka S / FacturaScripts
 * playgrounds.
 */
export function buildAutologinScript(config) {
  const user = escapePhp(config.admin?.username || "admin");
  const pass = escapePhp(config.admin?.password || "admin");
  return `<?php
require '${NEXTCLOUD_ROOT}/lib/base.php';
header('Content-Type: application/json');
try {
    $session = \\OC::$server->getSession();
    $userSession = \\OC::$server->getUserSession();
    $request = \\OC::$server->getRequest();
    $ok = $userSession->login('${user}', '${pass}');
    $user = $userSession->getUser();
    if ($ok && $user) {
        $userSession->createSessionToken($request, $user->getUID(), '${user}', '${pass}');
        // Mark the password as recently confirmed so admin pages don't prompt.
        $session->set('last-password-confirm', time());
    }
    $uid = $user ? $user->getUID() : null;
    $session->close();
    echo json_encode(['ok' => (bool) ($ok && $user), 'uid' => $uid]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`;
}
