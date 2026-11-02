# Quest Deck

A personal, gamified project and task deck for Work, Personal and Ministry.

- `index.html`: the claude.ai artifact version (source of truth for the app UI).
- `web/`: the standalone wrapper: `cloud.js` (Supabase sign-in, sync, calendar link) and `build.mjs`.
- `docs/`: the built site served by GitHub Pages. Rebuild with `node web/build.mjs`.
- `supabase/functions/calendar`: the iCalendar feed your iPhone Calendar subscribes to.
