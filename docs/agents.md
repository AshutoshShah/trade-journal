# Sending trades from an agent

The journal has a small API, `/ingest/v1`, made for agents: a personal AI assistant, a chat bot, a script that
reads your platform's export. You hand the agent your trade log after a session, in whatever form you have it,
and it sends the fills. You never type a trade in.

## Connect an agent in two minutes

1. Open your journal, go to **Settings**, and under **Agents and scripts** type a name for the agent (for example
   `my-assistant`) and press **Make a key**.
2. Press **Copy prompt for the agent** and paste it to your agent. The prompt holds the journal's address, the
   key, and what to do with your logs. The key is shown only once; if you lose it, revoke it and make another.
3. After your next session, send the agent your trade log: the platform's export, the text of its trades table,
   or a screenshot of it. The agent reads the instructions at `/ingest/v1/help`, sends every fill, and tells you
   about any warning the journal returned.
4. Open the journal. The day is there, grouped into positions, with the chart filled in shortly after.

Any agent that can make HTTPS requests can do this. Agents that cannot call APIs on their own can still
help: ask them to produce the JSON described below and send it with a script.

## What the agent reads

`GET /ingest/v1/help` returns the full instructions, written for an agent, with your journal's address and time
zone filled in. They cover:

- sending every individual fill rather than averages, with the order side (`buy` or `sell`);
- times: full date and time with seconds; times without an offset are read in the journal's time zone, or in a
  `time_zone` the request names;
- keeping the original log in `raw_log`, so a bad reading can be fixed later;
- splitting a very large day into numbered parts;
- attaching screenshots (when the journal has R2 turned on);
- reading back what was stored with `GET /ingest/v1/day?date=YYYY-MM-DD`.

## The smallest useful request

```bash
curl -X POST "https://your-journal.example.workers.dev/ingest/v1/day" \
  -H "X-API-Key: $JOURNAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-10-05",
    "platform": "tradovate",
    "raw_log": "the trades table as the platform showed it",
    "fills": [
      { "time": "2026-10-05 10:10:23", "side": "buy",  "qty": 2, "price": 21555.25, "instrument": "MNQZ6" },
      { "time": "2026-10-05 10:14:02", "side": "buy",  "qty": 1, "price": 21548.00, "instrument": "MNQZ6" },
      { "time": "2026-10-05 10:40:11", "side": "sell", "qty": 3, "price": 21600.00, "instrument": "MNQZ6" }
    ]
  }'
```

The response echoes every fill with the time as read, in UTC, and in New York time, plus any warnings (a position
that does not close, a time that could not be read). Sending the same day and platform again replaces what was
stored, so a corrected send is always safe.

## How it is kept apart and safe

- Each key has a name, and everything it sends is stored under that name. Two agents sending the same day never
  overwrite each other.
- Keys are random, 46 characters, and stored only as SHA-256 hashes. Revoking one in Settings stops it at once;
  what it already sent stays.
- A key can send fills and read back its own sends. It cannot read the rest of the journal, change settings or
  make other keys.
- Every request without a valid key gets `401` before anything else happens.

## Using a key from a secret instead

If you would rather manage keys as Cloudflare secrets, set one named `INGEST_KEY_<NAME>` (at least 24
characters, for example from `openssl rand -base64 32`). Sends with it are stored under `<name>` in lower case.
