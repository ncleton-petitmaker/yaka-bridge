# Bridge Security Test Matrix

Use this matrix before promoting a customer stack from smoke test to production.

## Identity And Sessions

- Public signup is refused when `GOTRUE_DISABLE_SIGNUP=true`.
- Invited user can sign in to Bridge and reopen the app without retyping a password.
- Signing out removes the account, service list, refresh token, access token and secure secret block.
- Revoked user cannot sync services, poll jobs or create launch tickets.
- Revoked device is hidden or marked revoked after the next Bridge sync.

## Launch Tickets

- Authorized service launch creates one short-lived ticket.
- First exchange succeeds and creates the service session.
- Second exchange with the same ticket fails.
- Expired ticket fails.
- Ticket created for service A cannot be exchanged by service B.
- Ticket exchange writes an audit event with organization, user, service and device.

## Service And Tenant Isolation

- User from organization A cannot read organization B memberships, services, jobs, events or audit rows.
- User entitled to service A cannot read service B jobs or job events.
- Admin from organization A cannot manage organization B services or entitlements.
- Disabled entitlement removes the service from Bridge after sync.
- Disabled service remains hidden from non-admin Bridge users.

## Codex Runtime Isolation

- Job for service A writes only under `<BridgeData>/services/service-a`.
- Job for service A cannot resolve `../service-b`.
- Job for service A cannot use an absolute path outside its allowed roots.
- Existing symlink inside service A pointing outside the service root is refused.
- `danger-full-access` job fails unless both job/service scopes explicitly include `codex:danger-full-access`.
- Remote OCR image URL must be HTTPS and cannot target localhost or private IP ranges.

## ERP Bus

- Authorized action call succeeds and records an audit event.
- Unauthorized action call fails and records an audit failure.
- Event payload schema validation rejects malformed payloads.
- Failed delivery retries with bounded backoff.
- Repeated failures land in a dead-letter queue.

## Release And Distribution

- macOS DMG is signed and notarized.
- Windows installer has a valid Authenticode signature.
- `SHA256SUMS` matches every published installer.
- Stable installer aliases match the current versioned artifacts.
- Bridge app name, bundle id, data directory and installer names remain `Bridge`.

## Backup And Recovery

- Postgres backup job succeeds.
- Storage backup job succeeds.
- Restore into a clean VPS returns expected `bridge_*` and `erp_*` rows.
- Restored stack can login, sync Bridge and open a service.
