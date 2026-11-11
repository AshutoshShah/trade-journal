# Setting up Trade journal: steps for an AI agent

These steps are written for a coding agent (Claude Code, Codex, Cursor or similar) that can run commands on the
user's computer. A person can follow them too. Work through them in order, run every command from the project
folder, and stop to ask the user wherever a step says so.

Rules while doing this:

- Never print, log or commit the journal password or any API key. Pass secrets through standard input as shown.
- Do not change anything in the user's Cloudflare account beyond what these steps create.
- If a step fails, show the user the error and the step, and ask before trying something different.

## 1. Check the tools

```bash
node --version
```

Node.js 20 or later is needed. If it is missing or older, ask the user to install the current LTS version from
https://nodejs.org and stop until they have.

```bash
git --version
```

## 2. Get the code

Ask the user where to put the project if they have a preference; otherwise use their home folder.

```bash
git clone https://github.com/AshutoshShah/trade-journal.git
```

```bash
cd trade-journal && npm install
```

## 3. Sign in to Cloudflare

```bash
npx wrangler whoami
```

If it says the user is not signed in, run the next command and tell the user to approve the request in the browser
window that opens. If they have no Cloudflare account, they can create a free one on that page.

```bash
npx wrangler login
```

If the user's login has more than one account, `wrangler whoami` lists them. Ask which one to use and set
`CLOUDFLARE_ACCOUNT_ID` to its ID for the remaining commands.

## 4. Choose the name (ask the user)

The Worker is named `trade-journal`, so the journal's address will be
`https://trade-journal.<their-subdomain>.workers.dev`. Ask the user whether that name is fine. If they want another,
change `name` in `wrangler.toml`, and `database_name` to match.

Ask also whether they want to sign in with a password (the default, nothing more to set up) or with Cloudflare
Access. For Access, follow the "Signing in" section of the README after step 7.

## 5. Deploy

```bash
npx wrangler deploy
```

This builds the web app, creates the D1 database (the first time), and deploys. Note the `https://...workers.dev`
address it prints. The tables are created by the Worker on first use; there is no migration to run.

If the deploy stops with a question about a `workers.dev` subdomain, the account has never used Workers. Ask the
user to pick a subdomain, then run the deploy again.

## 6. Set the password

Ask the user whether they want to choose the password or have one generated. It must be 12 characters or more;
the journal refuses anything shorter. To generate one:

```bash
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

Show the password to the user once, tell them to store it in their password manager, then set it without echoing
it into any log:

```bash
printf '%s' "THE_PASSWORD" | npx wrangler secret put APP_PASSWORD
```

## 7. Check it works

Replace the address with the one from step 5.

```bash
curl -s https://trade-journal.SUBDOMAIN.workers.dev/api/config
```

Expect `"configured":true` and `"signedIn":false`. Then confirm the API refuses requests without a key:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://trade-journal.SUBDOMAIN.workers.dev/ingest/v1/ping
```

Expect `401`. If `/api/config` shows `"configured":false`, the password secret did not save; repeat step 6.

## 8. Hand over

Tell the user:

- the journal's address, and that they sign in with the password from step 6;
- that their time zone is taken from the browser on the first visit and can be changed in Settings;
- that to have an agent send trades, they open **Settings**, make a key under **Agents and scripts**, and give the
  agent the prompt shown there (see docs/agents.md);
- optional extras, which they can ask for later: screenshots (needs R2, which asks for a payment method on the
  Cloudflare account), a custom domain, and Cloudflare Access. All are in the README.

Do not make an API key or send any trades on the user's behalf unless they ask.
