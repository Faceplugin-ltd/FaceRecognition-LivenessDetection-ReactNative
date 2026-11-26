#!/bin/bash
# Re-sign Face Recognition frameworks copied into the app (device installs).
set -euo pipefail

if [ "${PLATFORM_NAME:-}" = "iphonesimulator" ]; then
  exit 0
fi

if [ -z "${EXPANDED_CODE_SIGN_IDENTITY:-}" ] || [ "${EXPANDED_CODE_SIGN_IDENTITY}" = "-" ]; then
  echo "warning: EXPANDED_CODE_SIGN_IDENTITY unset; skipping Face Recognition codesign" >&2
  exit 0
fi

DEST="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"
if [ ! -d "${DEST}" ]; then
  exit 0
fi

sign_one() {
  local fw="$1"
  if [ ! -d "${fw}" ]; then
    return 0
  fi
  echo "Signing $(basename "${fw}") (${TARGET_NAME:-app})"
  /usr/bin/codesign --remove-signature "${fw}" 2>/dev/null || true
  /usr/bin/codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" \
    --preserve-metadata=identifier,entitlements,flags \
    --timestamp=none \
    "${fw}"
}

for name in facerecognitionsdk FacePluginSDK FacePPlugin FaceDetect; do
  sign_one "${DEST}/${name}.framework"
done
