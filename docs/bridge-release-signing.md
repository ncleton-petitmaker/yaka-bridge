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

Upload only signed/notarized artifacts to the customer Supabase Storage bucket.
Keep immutable versioned filenames for rollback and expose stable aliases for
the current recommended download:

```text
Bridge-0.1.0.dmg
Bridge-Setup-0.1.0.exe
Bridge.dmg
Bridge-Setup.exe
SHA256SUMS
```

`Bridge.dmg` and `Bridge-Setup.exe` are convenience aliases. They must point to
the same bytes listed in `SHA256SUMS`. Never overwrite them with unsigned smoke
test builds on a customer environment.

Before upload, verify:

```bash
shasum -a 256 release-bridge/Bridge-*.dmg release-bridge/Bridge-Setup-*.exe
spctl -a -vvv -t install release-bridge/Bridge-*.dmg
```

For Windows, run Authenticode verification on a Windows runner before publishing
the `.exe`.
