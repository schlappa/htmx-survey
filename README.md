# htmx-survey

Likert-scale survey. No CSS, no frontend framework. Runs on Cloudflare Workers + D1.

    public/          index.html, results.html, questions.json — served as static assets
    src/worker.js    all routes (deployed)
    server.cjs       the original Node server, for local use only
    schema.sql       D1 schema

## Deploy to Cloudflare (free)

You need a Cloudflare account. No credit card, no domain.

    cd /c/code/htmx-survey
    npm install
    npx wrangler login                      # opens a browser once
    npx wrangler d1 create htmx-survey      # prints a database_id

Paste that id into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`, then:

    npx wrangler d1 execute htmx-survey --remote --file=./schema.sql
    npx wrangler secret put RESULTS_PASSWORD    # prompts; this guards /results
    npx wrangler deploy

You get a URL like `https://htmx-survey.<your-subdomain>.workers.dev`. The survey is
at `/`, the results at `/results`.

## Local development

    npm run dev                             # wrangler, on :8787
    npm run db:local                        # apply schema.sql to the local D1

`wrangler dev` uses a local SQLite file under `.wrangler/`, so local submissions
never touch the deployed database. To pass a password locally:

    npx wrangler dev --var RESULTS_PASSWORD:testpw

`npm run node` still runs the original `server.cjs` on :3000 with its own
`survey.db`. It is not deployed and the two do not share data.

## Editing the survey

`public/questions.json` holds the title, intro, scale labels and questions. Add or
remove entries in `questions`; both the form and the results tables follow. It is
bundled into the Worker at build time, so a change needs a redeploy.

## Results and authentication

`/results` shows per-question averages with a 1-5 distribution, plus every raw
response newest first. Both tables are htmx fragments that reload every 30 seconds.

The results routes are protected by HTTP Basic auth. Any username works; the
password is the `RESULTS_PASSWORD` secret. **If the secret is unset the page is
locked, not open** — it fails closed. Two buttons there seed canned responses
(all 1s with the comment `cat1`, all 5s with none); seeded rows are flagged
`simulated` in the Source column. Clear them with:

    npx wrangler d1 execute htmx-survey --remote \
      --command="DELETE FROM responses WHERE simulated = 1"

## Data collected

Each row stores the answers, the comment, `ip`, `latitude`, `longitude`,
`location` (city name), `user_agent` and the `simulated` flag.

- Location comes from Cloudflare's edge, which resolves the visitor's IP as the
  request arrives. No third-party API, no rate limit, nothing sent off-network.
- The coordinates are the **centroid of the visitor's city**, not their real
  position: everyone on one connection gets identical values and the error is
  kilometres. The city name is the tooltip on the coordinates.
- There is no MAC column. The Node version read it from the local ARP cache,
  which needs a shared network segment — it was always null for anyone off the
  LAN, and Workers have no OS to ask.
- Two buttons on the survey page fill the form for testing without submitting.
  Delete that "Testing" paragraph in `public/index.html` before sending the
  survey to real respondents.

## Free tier

D1 allows 5 GB, 5M row reads/day and 100k row writes/day; Workers allow 100k
requests/day. A survey will not approach any of these. Workers do not sleep, so
there is no cold-start delay for respondents.
