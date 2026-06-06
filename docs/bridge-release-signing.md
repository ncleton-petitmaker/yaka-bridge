# Bridge Release Signing

Bridge installers must be signed and, on macOS, notarized before customer distribution.

## macOS

Required:

- Apple Developer Program membership.
- `Developer ID Application` certificate installed in the macOS Keychain.
- Notary credentials available to `electron-builder`.

Supported environment variables:

```bash
export APPLE_ID="admin@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID1234"
```

Then build:

```bash
npm run bridge:pack:mac
spctl -a -vvv -t install release-bridge/Bridge-*.dmg
```

Expected production result: `accepted` with Apple notarization source. If `spctl`
returns `no usable signature`, the machine has no usable Developer ID identity
and macOS Gatekeeper will show the malware warning.

## Windows

Use an Authenticode code-signing certificate for production `.exe` installers.
Unsigned Windows builds are acceptable only for internal smoke tests.

## Distribution

Upload only the signed/notarized stable filenames to the customer Supabase
Storage bucket:

```text
Bridge.dmg
Bridge-Setup.exe
SHA256SUMS
```
