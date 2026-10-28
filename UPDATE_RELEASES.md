# Signed update releases

OpenBeacon checks the `update-feed` branch's `latest.json` for signed beta updates. The first updater-enabled Windows installer or Linux AppImage must be installed manually; the old portable beta cannot update itself. The app checks automatically but only downloads and installs when the user chooses to do so. Installation is blocked while beaconing, transmitting, or downloading maps. Application data is separate from installation files.

The updater verifies signatures and requires the signed version to match the manifest. The signing public key is embedded in `src-tauri/tauri.conf.json`; keep the private signing key and its password secure and backed up. The repository's Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` supply the CI builds. Losing or replacing the key prevents existing installations from accepting new updates without a manual migration.

To prepare a release:

1. Update the SemVer version consistently in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Commit and push the changes.
2. Run the **Prepare signed release** GitHub Actions workflow with the matching `v`-prefixed tag. It builds a Linux AppImage and Windows NSIS installer sequentially, signs both and creates a draft prerelease with `latest.json`. Review its assets, signatures, notes and results. Test on both operating systems before asking others to install it.
3. Publish the reviewed draft. The **Publish signed update feed** workflow verifies the version, platform URLs, signatures and version ordering, then updates `latest.json` on the `update-feed` branch. It rejects releases without both signed platform artifacts and does not roll the feed back to an older version. The current feed includes beta and stable releases; a separate stable-only channel is not implemented.
4. Verify the feed workflow succeeded and test a real upgrade from an earlier updater-enabled installation on both platforms. Signing updates is separate from Windows Authenticode code signing; an unsigned installer may still trigger SmartScreen.

Never commit the private key or password. A CI artifact or a draft is not publicly offered by the update feed until the release is published and the feed workflow succeeds.
