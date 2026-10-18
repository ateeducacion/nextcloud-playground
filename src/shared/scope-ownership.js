// See docs/development.md#exclusive-scope-ownership.
export function acquireScopeOwnership(
  scopeId,
  locks = globalThis.navigator?.locks,
) {
  return new Promise((resolve, reject) => {
    if (!locks) {
      reject(
        new Error(
          "Web Locks are required to safely open this playground scope.",
        ),
      );
      return;
    }
    locks
      .request(
        `nextcloud-playground-owner:${scopeId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            throw new Error(
              "This playground scope is already open in another tab. Close that tab and reload, or open a new scope.",
            );
          }
          // Keep ownership until the remote document has terminated its PHP worker.
          await new Promise((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}
