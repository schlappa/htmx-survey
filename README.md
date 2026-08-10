# htmx-survey

Multi-user survey builder on Cloudflare Workers + D1. Forms, sections and
questions live in the database; nothing is read from disk. No CSS.

    src/worker.js    routing, form builder, submission, results, export
    src/auth.js      PBKDF2 password hashing and cookie sessions
    src/render.js    HTML rendering
    src/xlsx.js      minimal .xlsx writer (no dependency)
    schema.sql       D1 schema
    scripts/         create-user.mjs

## Routes

| Route | Who |
|---|---|
| `/` | login |
| `/forms` | list your forms |
| `/forms/:id` | edit header, sections, questions, settings |
| `/forms/:id/results` | summary + raw responses |
| `/forms/:id/export` | `.xlsx` download |
| `/f/:slug` | the public form — no login needed |

Everything except `/f/:slug` requires a session. Forms are owner-scoped: another
signed-in user gets a 404, not a 403, so the existence of a form is not leaked.
Admins (`is_admin = 1`) see every form.

## Setup

    npm install
    npx wrangler d1 execute htmx-survey --remote --file=./schema.sql
    npm run create-user -- you@example.com "Your Name" "a-strong-password" --admin
    npx wrangler deploy

**`schema.sql` is destructive** — it drops every table before recreating them.
Back up first:

    npx wrangler d1 export htmx-survey --remote --output=./backup.sql

## Local development

    npm run dev                    # :8787, local SQLite under .wrangler/
    npm run db:local               # apply schema.sql locally
    npm run create-user -- a@b.c "Name" "pw" --admin --local

Local dev uses its own database, so it never touches production data.

## Building a form

Create it from `/forms`, then on the edit page set the header text (title,
subtitle, objective, instructions) and add sections. A section is either:

- **matrix** — a Likert grid: the scale runs across the top, one row per question
- **text** — a single free-text box

Per-form settings:

- **scale 5→1** — column order. On by default, matching the Univalle layout.
- **require comment** — rating any question the *lowest* scale value makes a
  free-text section mandatory. Needs at least one text section to have an effect.
- **track metadata** — off by default, so forms are anonymous. When on, each
  response records IP, coordinates, city and user agent from Cloudflare's edge.
- **is_open** — closed forms show a notice instead of the questions.

## Results and export

`/forms/:id/results` shows per-question averages with the rating distribution,
free-text answers, and one row per response. `/forms/:id/export` produces a real
`.xlsx` (verified opening in Excel) with one row per response and one column per
question.

## Notes

- Passwords are PBKDF2-SHA256, 100k iterations, per-user salt. Sessions are
  opaque random tokens in an HttpOnly, Secure, SameSite=Lax cookie (30 days).
- Public form URLs use a 9-character random slug, so the link is the access
  control. Anyone with it can respond.
- There is no self-signup: accounts are created with `create-user.mjs`.
- Free tier: D1 allows 5 GB, 5M row reads and 100k row writes per day.
