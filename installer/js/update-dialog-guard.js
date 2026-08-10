// Update-only guard for the ESP Web Tools install dialog.
//
// The Update button on the Aliro installer always keeps setup. Its manifest
// declares `new_install_prompt_erase: true`, so ESP Web Tools renders an
// ASK_ERASE step whose checkbox chooses erase-first. This module scopes
// the patch to dialogs whose `manifestPath` matches the Update button's
// manifest and, using the dialog's open shadow root only:
//
// 1. injects a scoped `<style>` that hides the erase checkbox and its label
// 2. forces `ew-checkbox.checked = false` and `.disabled = true`, so the
//    hidden Next-button handler reads a false checkbox and calls the
//    keep-setup install path.
//
// A canceled Update picker followed by a Factory click never patches the
// Factory dialog: the observer inspects each new `ewt-install-dialog`'s
// `manifestPath` before touching it.
//
// This uses ESP Web Tools' private DOM. It is pinned to PR 733 commit
// cf6936234a6a37a5028bd2e39eca899bed8a0cd9 and must be revisited on any
// vendor bump. See installer/vendor/UPSTREAM.md and the pinned-vendor
// invariant test in installer/tests/node-tests.mjs.

const STYLE_MARKER = "data-aliro-update-guard";
const DIALOG_TAG = "ewt-install-dialog";

export function patchUpdateDialogShadow(shadowRoot) {
  if (!shadowRoot || typeof shadowRoot.querySelector !== "function") return false;
  ensureGuardStyle(shadowRoot);
  return forceEraseChoiceOff(shadowRoot);
}

function ensureGuardStyle(shadowRoot) {
  if (shadowRoot.querySelector(`style[${STYLE_MARKER}]`)) return;
  const doc = shadowRoot.ownerDocument || globalThis.document;
  const style = doc.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = "label.formfield { display: none !important; }";
  shadowRoot.appendChild(style);
}

function forceEraseChoiceOff(shadowRoot) {
  const checkbox = shadowRoot.querySelector("ew-checkbox");
  if (!checkbox) return false;
  checkbox.checked = false;
  checkbox.disabled = true;
  return true;
}

function isMatchingDialog(node, updateManifestPath) {
  if (!node || typeof node.tagName !== "string") return false;
  if (node.tagName.toLowerCase() !== DIALOG_TAG) return false;
  return node.manifestPath === updateManifestPath;
}

export function attachUpdateDialogGuard({
  updateManifestPath,
  doc = globalThis.document,
  observerFactory = globalThis.MutationObserver,
}) {
  if (!updateManifestPath || !doc?.body || typeof observerFactory !== "function") {
    return { disconnect() {} };
  }
  const shadowObservers = new WeakMap();
  const bodyObserver = new observerFactory((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes || []) {
        if (isMatchingDialog(added, updateManifestPath)) {
          startShadowWatch(added, observerFactory, shadowObservers);
        }
      }
      for (const removed of mutation.removedNodes || []) {
        const shadowObserver = shadowObservers.get(removed);
        if (shadowObserver) {
          shadowObserver.disconnect();
          shadowObservers.delete(removed);
        }
      }
    }
  });
  bodyObserver.observe(doc.body, { childList: true });
  return {
    disconnect() {
      bodyObserver.disconnect();
    },
  };
}

function startShadowWatch(dialog, observerFactory, shadowObservers) {
  const shadow = dialog.shadowRoot;
  if (!shadow) return;
  patchUpdateDialogShadow(shadow);
  const shadowObserver = new observerFactory(() => {
    patchUpdateDialogShadow(shadow);
  });
  shadowObserver.observe(shadow, { childList: true, subtree: true });
  shadowObservers.set(dialog, shadowObserver);
}
