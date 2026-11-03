/* Quest Deck standalone: sign-in, Supabase sync and the calendar link.
   Gives the app the same `claude.use('db')` surface it has on claude.ai, backed by the qd_docs table. */
(() => {
  const SB_URL = 'https://guxwjjwcynecaqymxxfk.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1eHdqandjeW5lY2FxeW14eGZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MjcxMDAsImV4cCI6MjEwOTIwMzEwMH0.WhBttMeoNGRzWsRDR_zh6J6Jbwu_rpJrjwS8eCl1jGg';
  const FEED = SB_URL + '/functions/v1/calendar?token=';
  const sb = supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'qd-auth' } });

  let resolveDb; const dbReady = new Promise(r => (resolveDb = r));
  window.claude = { use: async name => (name === 'db' ? dbReady : null) };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const domReady = new Promise(r => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
  let user = null;

  /* ---------- db adapter ---------- */
  const split = path => { const [coll, id] = path.split('/'); return { coll, id }; };
  const subs = [];            // {coll, id?, cb, err, loaded}
  const pending = {};         // coll -> writes in flight
  const timers = {};
  async function fetchColl(coll) {
    const { data, error } = await sb.from('qd_docs').select('id,data').eq('coll', coll);
    if (error) throw error;
    return data;
  }
  async function refresh(coll) {
    const mine = subs.filter(s => s.coll === coll);
    if (!mine.length) return;
    let rows;
    try { rows = await fetchColl(coll); }
    catch (e) { mine.forEach(s => { if (!s.loaded && s.err) s.err(e); }); return; }
    for (const s of mine) {
      s.loaded = true;
      if (s.id) { const r = rows.find(r => r.id === s.id); s.cb({ exists: !!r, data: () => (r ? r.data : undefined), metadata: { fromCache: false } }); }
      else s.cb({ docs: rows.map(r => ({ id: r.id, data: () => r.data })), metadata: { fromCache: false } });
    }
  }
  // wait for this device's own writes to land before re-reading, so an edit never flickers back
  function schedule(coll) {
    clearTimeout(timers[coll]);
    timers[coll] = setTimeout(() => (pending[coll] ? schedule(coll) : refresh(coll)), 350);
  }
  const track = (coll, p) => { pending[coll] = (pending[coll] || 0) + 1; return p.finally(() => { pending[coll]--; }); };
  const listen = (coll, id, cb, err) => { subs.push({ coll, id, cb, err, loaded: false }); refresh(coll); return () => subs.splice(subs.findIndex(s => s.cb === cb), 1); };
  const db = {
    collection: coll => ({ onSnapshot: (cb, err) => listen(coll, null, cb, err) }),
    doc: path => {
      const { coll, id } = split(path);
      return {
        onSnapshot: (cb, err) => listen(coll, id, cb, err),
        set: body => track(coll, sb.from('qd_docs').upsert({ user_id: user.id, coll, id, data: body, updated_at: new Date().toISOString() })
          .then(({ error }) => { if (error) throw error; })),
        delete: () => track(coll, sb.from('qd_docs').delete().eq('coll', coll).eq('id', id)
          .then(({ error }) => { if (error) throw error; })),
      };
    },
  };
  function startSync() {
    sb.channel('qd-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qd_docs', filter: 'user_id=eq.' + user.id },
        p => { const c = (p.new && p.new.coll) || (p.old && p.old.coll); if (c) schedule(c); else ['projects', 'tasks', 'meta'].forEach(schedule); })
      .subscribe();
    // phones pause pages in the background: catch up when the app comes back
    const catchUp = () => { if (document.visibilityState === 'visible') ['projects', 'tasks', 'meta'].forEach(schedule); };
    document.addEventListener('visibilitychange', catchUp);
    addEventListener('online', catchUp);
    resolveDb(db);
  }

  /* ---------- sign-in ---------- */
  function overlay(html, closable) {
    let root = $('cloud-root');
    if (!root) { root = document.createElement('div'); root.id = 'cloud-root'; document.body.appendChild(root); }
    root.innerHTML = html ? `<div class="scrim" id="cloud-scrim" style="z-index:70">${html}</div>` : '';
    if (closable) $('cloud-scrim').addEventListener('click', e => { if (e.target.id === 'cloud-scrim') overlay(''); });
  }
  function showLogin(msg) {
    overlay(`<form class="sheet" id="login" autocomplete="on" style="gap:14px">
      <div class="brand" style="font:800 22px var(--f-display)">Quest Deck</div>
      <p style="color:var(--muted);font-size:14px;margin:0">Sign in to sync your quests between your PC and iPhone.</p>
      <div class="field"><label for="li-email">Email</label><input id="li-email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="li-pass">Password</label><input id="li-pass" type="password" autocomplete="current-password" minlength="8" required></div>
      <div id="li-msg" role="status" style="font-size:13px;color:var(--muted)">${msg ? esc(msg) : ''}</div>
      <div class="foot"><button class="btn" type="button" id="li-new">First time? Create account</button><button class="btn primary" type="submit">Sign in</button></div>
    </form>`);
    const say = t => { $('li-msg').textContent = t; };
    const creds = () => ({ email: $('li-email').value.trim(), password: $('li-pass').value });
    $('login').addEventListener('submit', async e => {
      e.preventDefault(); say('Signing in…');
      const { error } = await sb.auth.signInWithPassword(creds());
      if (error) say(/confirm/i.test(error.message) ? 'Confirm your email first: open the link we emailed you, then sign in here.' : 'That email and password did not match. Try again.');
    });
    $('li-new').addEventListener('click', async () => {
      if (!$('login').reportValidity()) return;
      say('Creating your account…');
      const { data, error } = await sb.auth.signUp({ ...creds(), options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) say(/closed|database error/i.test(error.message) ? 'This Quest Deck is private to its owner.' : error.message);
      else if (!data.session) say('Check your email and tap the confirm link. Then come back here and sign in.');
    });
  }

  /* ---------- calendar + account sheet ---------- */
  async function feedUrl() {
    let { data } = await sb.from('qd_feed').select('token').maybeSingle();
    if (!data) ({ data } = await sb.from('qd_feed').insert({ user_id: user.id }).select('token').single());
    return data ? FEED + data.token : null;
  }
  async function showAccount() {
    overlay(`<div class="sheet"><h2>Calendar &amp; account</h2><p style="color:var(--muted)">Loading your calendar link…</p></div>`, true);
    const url = await feedUrl().catch(() => null);
    if (!url) { overlay(`<div class="sheet"><h2>Calendar &amp; account</h2><p>Could not load your calendar link. Check your connection and try again.</p></div>`, true); return; }
    overlay(`<div class="sheet">
      <h2>Put Quest Deck in your iPhone Calendar</h2>
      <p style="margin:0;font-size:14px">Every task with a due date, today's plan and project deadlines show up in Calendar with reminders: 9am on the day, plus a heads-up before important ones.</p>
      <a class="btn primary" href="${esc(url.replace(/^https:/, 'webcal:'))}" style="justify-content:center;text-decoration:none">Subscribe on this iPhone</a>
      <ol style="margin:0;padding-left:20px;font-size:14px;display:grid;gap:4px">
        <li>Tap the button above, then <b>Subscribe</b>.</li>
        <li>Turn <b>Remove Alerts</b> off, so the reminders buzz.</li>
        <li>Tap <b>Add</b>. Changes show up within about 15 minutes to an hour.</li>
      </ol>
      <div class="field"><span class="lbl">Or copy the link (Mac, Google Calendar, Outlook)</span><input id="feed-url" readonly value="${esc(url)}"></div>
      <p style="margin:0;font-size:12px;color:var(--muted)">Anyone with this link can see your task titles. Keep it to yourself.</p>
      <div class="foot"><span style="font-size:13px;color:var(--muted);align-self:center">Signed in as ${esc(user.email)}</span>
        <span style="display:flex;gap:8px"><button class="btn" id="feed-copy" type="button">Copy link</button><button class="btn danger" id="sign-out" type="button">Sign out</button></span></div>
    </div>`, true);
    $('feed-url').addEventListener('focus', e => e.target.select());
    $('feed-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); $('feed-copy').textContent = 'Copied'; } catch { $('feed-url').select(); }
    });
    $('sign-out').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
  }

  /* ---------- start ---------- */
  let started = false;
  async function onSession(session) {
    if (!session || started) return;
    started = true; user = session.user;
    await domReady; overlay(''); startSync();
    $('cloud-btn')?.addEventListener('click', showAccount);
  }
  sb.auth.onAuthStateChange((evt, session) => { if (evt === 'SIGNED_OUT' && started) location.reload(); else onSession(session); });
  sb.auth.getSession().then(async ({ data }) => { if (data.session) onSession(data.session); else { await domReady; if (!started) showLogin(); } });
})();
