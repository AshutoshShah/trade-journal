# Security

Trade journal holds people's trading records, so security reports are welcome and taken seriously.

## Reporting a problem

Please report it privately, not in a public issue: on GitHub, open the repository's **Security** tab and choose
**Report a vulnerability**. Include what you found, how to reproduce it, and what it exposes. You will get an
answer within a week.

## What is in scope

- Signing in: the password check, the session cookie, the Cloudflare Access check.
- The ingest API: keys, what a key can read or write.
- Anything that could expose one journal's data to someone without its password or a key.

Problems in Cloudflare itself belong with Cloudflare's own programme.

## Supported versions

Fixes go into the latest version on `main`. Updating is described in the README.
