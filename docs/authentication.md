# Authentication

Replace `klippee.example.com` with the HTTPS origin of your instance in the
examples below.

Klippee should support sign-in with GitHub and Discord.

GitHub is useful for package authorship, attribution, and future repository
import/export. Discord is useful for community identity and printer-sharing
groups.

## Providers

### GitHub

Use GitHub OAuth web application flow.

Recommended scopes for login:

```text
read:user
```

Avoid requesting repository scopes for normal login. If Klippee later imports
from or exports to GitHub repositories, request that permission in a separate
connected-account flow.

Do not request `user:email` for normal login. Klippee can identify a GitHub user
by provider user id and username. Email can be requested later in a separate
consent flow if the product adds account recovery, notifications, or repository
features that genuinely need it.

### Discord

Use Discord OAuth2.

Recommended scopes for login:

```text
identify
```

Avoid guild or bot permissions for normal login. Community features can request
additional Discord permissions later if they are genuinely needed.

Do not request `email` for normal login. Discord's `identify` scope provides the
basic profile Klippee needs for sign-in.

## Account Model

Users can sign in with either provider and later link the other provider.

Suggested D1 tables:

```text
users
  id
  display_name
  avatar_url
  created_at
  updated_at

user_identities
  id
  user_id
  provider
  provider_user_id
  provider_username
  avatar_url
  created_at
  updated_at

sessions
  id
  user_id
  session_hash
  expires_at
  created_at
```

`provider` should be one of:

```text
github
discord
```

## Flow

1. User clicks "Continue with GitHub" or "Continue with Discord".
2. Worker creates a `state` value and a fresh 256-bit PKCE verifier, persists
   both in the short-lived D1 state row, and derives
   `BASE64URL(SHA256(verifier))`. Only the verifier remains server-side; state
   is also sent in the state cookie and authorization request.
3. Worker redirects to the provider authorization URL with the derived
   `code_challenge` and `code_challenge_method=S256`. The verifier is never
   sent to the browser or authorization endpoint.
4. Provider redirects back to `https://klippee.example.com/api/auth/:provider/callback`.
5. Worker validates the state cookie, atomically consumes the matching D1 row,
   checks its provider and expiry, and sends the consumed verifier as
   `code_verifier` while exchanging the code. A code issued for a different
   browser flow cannot pass that provider-side proof.
6. Worker creates or links a `user_identities` record.
7. Worker creates a Klippee session.
8. Browser receives an HTTP-only secure session cookie.

## Production Verification

Automated smoke checks verify the parts of auth that do not require interacting
with GitHub or Discord accounts:

- `/api/auth/me` returns `{ "user": null }` before login.
- `/api/auth/github/start` redirects to GitHub with
  `redirect_uri=https://klippee.example.com/api/auth/github/callback`, an S256
  challenge, and no verifier.
- `/api/auth/discord/start` redirects to Discord with
  `redirect_uri=https://klippee.example.com/api/auth/discord/callback`, an S256
  challenge, and no verifier.
- Anonymous requests to `/api/repos`, `/api/printers`,
  `/api/private-packages`, and `/api/app-state` return `401`.

Manual production checks are still required before launch:

1. Start GitHub login from `https://klippee.example.com`.
2. Confirm GitHub redirects back to `https://klippee.example.com` and `/api/auth/me`
   returns a user object with `id`, `displayName`, and optional `avatarUrl`.
3. Inspect the session cookie and confirm `HttpOnly`, `Secure`,
   `SameSite=Lax`, and `Path=/`.
4. Log out and confirm `/api/auth/me` returns anonymous state.
5. Repeat the same flow for Discord.
6. Confirm anonymous users can browse and render public packages but cannot load
   private printer, repository, package, or app-state APIs.

## Session Cookies

Session cookies should be:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
```

For local development, use a separate non-production cookie name and allow
`http://localhost` callbacks.

## Browser Account Boundaries

The frontend resolves `/api/auth/me` before mounting workspace state. Browser
workspace data uses an explicit anonymous namespace or a namespace derived from
the authenticated Klippee user ID. Changing accounts or completing logout
remounts the application against the new namespace, so printers, drafts,
private packages, companion assets, and CAD source from one account are never
reused by another. Account data is hydrated from IndexedDB before workspace
state mounts; file bodies are shared only within their owner scope. Legacy
unscoped `klippee.mvp.*` workspace keys are preserved in an isolated archive
and are not assigned to a user whose ownership cannot be proven. See
[browser storage](browser-storage.md) for migration and failure behavior.
Navigation layout and non-account parametric-CAD preferences remain
device-wide; printer configuration, package, asset, variable, and CAD source
data do not.

On a returning browser, a non-empty account-scoped text or structural draft
wins over an older cloud app-state snapshot and resumes cloud autosave after
the dedicated printer metadata is reconciled. A clean or new browser scope can
still hydrate from cloud app-state. Local-only printer values are retained in
that account scope while permitted non-secret values from the printer API are
overlaid as the authoritative cloud values.

The client changes to signed-out state only after a validated successful
logout response. The Worker always expires the browser cookie, even when its
best-effort D1 session-row cleanup fails, and emits a structured operational
error without logging the cookie or session hash.

Cloud app-state snapshots intentionally omit top-level variable values and
printer `variableValues`. The dedicated printer API remains the only cloud path
for permitted non-secret values, while secret values remain host-local. The
Worker strips these fields on both app-state writes and legacy reads so an
older browser build cannot bypass that boundary.

Printer metadata updates also omit `variableValues`; only an explicit variable
edit sends them. The Worker treats an omitted field as "leave unchanged" and
an explicit empty object as "clear", so a stale tab renaming or rebinding a
printer cannot overwrite a newer variable edit. Package secret reclassification
atomically removes affected values from every already-bound printer.

## Token Storage

OAuth state rows contain a one-time PKCE verifier that is usable for the
10-minute state TTL and removed on callback or by bounded expiry cleanup. The
callback deletes the row before contacting the provider, so concurrent or
replayed callbacks cannot reuse it. Migration `0023_oauth_pkce.sql`
invalidates pre-PKCE in-flight states; legacy/null or malformed verifier rows
fail closed and require the user to restart sign-in.

Do not store provider access tokens unless a feature needs ongoing provider API
access.

For ordinary login, discard provider tokens after fetching the user profile and
basic profile. Store only the provider identity id, username, and avatar.

If Klippee later needs email, request the provider email scope through an
explicit upgrade flow and store the email only after that separate consent.

If a future GitHub import/export feature needs repository access, store that
token encrypted and scoped separately from login.

## API Endpoints

```text
GET    /api/auth/me
POST   /api/auth/logout
GET    /api/auth/github/start
GET    /api/auth/github/callback
GET    /api/auth/discord/start
GET    /api/auth/discord/callback
POST   /api/auth/link/github
POST   /api/auth/link/discord
DELETE /api/auth/identities/:provider
```

## Environment Variables

Cloudflare secrets:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
SESSION_SECRET
```

Public app config:

```text
APP_ORIGIN=https://klippee.example.com
```

## Authorization

Authentication proves who the user is. Authorization decides what they can do.

Initial roles:

- anonymous: browse public packages, render public packages, download zip
- user: create private repos, save variables, edit configs, sync printers
- owner: manage package/repo settings, delete versions where allowed
- admin: moderate Shared Configs content

Printer sync tokens are separate from browser sessions. A printer token should
belong to one printer profile and should not grant normal web login.

## Sources

- PKCE specification: https://www.rfc-editor.org/rfc/rfc7636
- GitHub OAuth web flow and PKCE parameters: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Discord OAuth2 docs: https://docs.discord.com/developers/topics/oauth2
- Discord PKCE token exchange guidance: https://docs.discord.com/developers/discord-social-sdk/development-guides/account-linking-on-mobile
