# Quest Deck

A personal, gamified project and task deck for Work, Personal and Ministry.

- `app.html`: the claude.ai artifact version (source of truth for the app UI).
- `web/`: the standalone wrapper: `cloud.js` (Supabase sign-in, sync, calendar link) and `build.mjs`.
- `index.html`, `cloud.js`, `manifest.webmanifest`, `icon-*.png` at the root: the built site GitHub Pages serves. Rebuild with `node web/build.mjs`.
- `supabase/functions/calendar`: the iCalendar feed your iPhone Calendar subscribes to.
