import { NEXTCLOUD_ROOT } from "./bootstrap-paths.js";

const escapePhp = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

/**
 * PHP that creates a Nextcloud share through OCP\Share\IManager.
 *
 * Stock Nextcloud has no `occ` command for creating shares (the OCS Share API
 * is the public surface). Running the Share Manager in-process avoids CSRF
 * and cookie-jar setup that a POST to /ocs/v2.php/... would need under wasm.
 */
export function buildCreateShareScript({
  owner,
  userPath,
  shareType,
  shareWith = "",
  permissions,
  password = "",
  expireDate = "",
  note = "",
  label = "",
} = {}) {
  const uid = escapePhp(owner || "admin");
  const rel = escapePhp(userPath || "");
  const withUser = escapePhp(shareWith || "");
  const pass = escapePhp(password || "");
  const expires = escapePhp(expireDate || "");
  const shareNote = escapePhp(note || "");
  const shareLabel = escapePhp(label || "");
  const type = Number(shareType);
  const perms = Number(permissions);

  return `<?php
unset($_SERVER['REQUEST_URI']);
chdir('${NEXTCLOUD_ROOT}');
require '${NEXTCLOUD_ROOT}/lib/base.php';
header('Content-Type: application/json');
try {
    $owner = '${uid}';
    $userPath = '${rel}';
    $userManager = \\OC::$server->getUserManager();
    $userSession = \\OC::$server->getUserSession();
    $user = $userManager->get($owner);
    if (!$user) {
        echo json_encode(['ok' => false, 'error' => "user not found: $owner"]);
        return;
    }
    $userSession->setUser($user);
    \\OC_User::setUserId($owner);
    \\OC_Util::setupFS($owner);

    $root = \\OC::$server->get(\\OCP\\Files\\IRootFolder::class);
    $folder = $root->getUserFolder($owner);
    $node = $userPath === '' ? $folder : $folder->get($userPath);

    $shareManager = \\OC::$server->get(\\OCP\\Share\\IManager::class);
    $share = $shareManager->newShare();
    $share->setNode($node);
    $share->setShareType(${Number.isFinite(type) ? type : 3});
    $share->setSharedBy($owner);
    $share->setShareOwner($owner);
    $share->setPermissions(${Number.isFinite(perms) ? perms : 1});
    $share->setMailSend(false);
    if ('${withUser}' !== '') {
        $share->setSharedWith('${withUser}');
    }
    if ('${pass}' !== '') {
        $share->setPassword('${pass}');
    }
    if ('${expires}' !== '') {
        $share->setExpirationDate(new DateTime('${expires}'));
    }
    if ('${shareNote}' !== '') {
        $share->setNote('${shareNote}');
    }
    if ('${shareLabel}' !== '') {
        $share->setLabel('${shareLabel}');
    }

    $created = $shareManager->createShare($share);
    echo json_encode([
        'ok' => true,
        'id' => $created->getId(),
        'token' => $created->getToken(),
        'shareType' => $created->getShareType(),
    ]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`;
}
