# Contributing

Thanks for helping. Bug reports, fixes and small improvements are welcome.

- **Bugs:** open an issue with what you did, what you expected and what happened. Leave out real trades, keys and
  passwords; made-up numbers are enough to show a problem.
- **Changes:** open a pull request against `main`. Keep it focused on one thing.
- **Before sending:** run `npm test`, and run the journal locally with `npx wrangler dev` to check the pages you
  touched. `test/e2e.mjs` checks sign-in, keys and ingest against a local server.
- **The free plan is a requirement.** A change must keep the journal inside Cloudflare's free limits: at most 50
  database queries per request, no scheduled jobs, no paid products required.
- **Database changes are additive only:** new tables and columns, created by the Worker on first use. Never drop
  or rename something that holds a user's data.
- **The ingest contract** (`worker/ingest-guide.txt`) is what agents read. Any change to how `/ingest` behaves
  updates that file in the same pull request.
- **Writing:** text people read in the app should be plain and specific.
