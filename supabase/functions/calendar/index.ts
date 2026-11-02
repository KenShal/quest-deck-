// Quest Deck calendar feed: an iCalendar (.ics) subscription that iPhone / Google Calendar can subscribe to.
// GET /functions/v1/calendar?token=<secret from qd_feed>
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const esc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const ymd = (d: string) => d.replaceAll("-", "");
function nextDay(d: string) {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
// RFC 5545 line folding (75 octets)
function fold(line: string) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
// all-day events start at local midnight, so +PT9H = 9am that day, -PT4H = 8pm the day before
const alarm = (trigger: string, text: string) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(text)}`, `TRIGGER:${trigger}`, "END:VALARM"];

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Not found", { status: 404 });
  const { data: feed } = await sb.from("qd_feed").select("user_id").eq("token", token).maybeSingle();
  if (!feed) return new Response("Not found", { status: 404 });

  const { data: rows, error } = await sb.from("qd_docs").select("coll,id,data").eq("user_id", feed.user_id).in("coll", ["projects", "tasks"]);
  if (error) return new Response("Error", { status: 500 });

  const projects: Record<string, any> = {};
  const tasks: any[] = [];
  for (const r of rows ?? []) {
    if (r.coll === "projects") projects[r.id] = r.data;
    else tasks.push({ id: r.id, ...r.data });
  }
  const cutoff = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Quest Deck//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Quest Deck", "X-WR-CALDESC:Tasks and deadlines from Quest Deck",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  const event = (uid: string, day: string, summary: string, desc: string, alarms: string[][]) => {
    L.push("BEGIN:VEVENT", `UID:${uid}@quest-deck`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(nextDay(day))}`,
      `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(desc)}`, "TRANSP:TRANSPARENT", ...alarms.flat(), "END:VEVENT");
  };

  for (const t of tasks) {
    if (!t.title || t.status === "done" || t.status === "someday") continue;
    const p = t.projectId ? projects[t.projectId] : null;
    const cat = p?.area || t.cat || "";
    const tag = (cat ? `[${cat}] ` : "") + (t.priority === 1 ? "‼ " : "");
    const desc = [p ? `Project: ${p.name}` : "", t.status === "waiting" && t.waitingOn ? `Waiting on: ${t.waitingOn}` : "", t.recur ? `Repeats: ${t.recur}` : "", t.notes || ""].filter(Boolean).join("\n");
    if (t.due && t.due >= cutoff) {
      const al = [alarm("PT9H", `Due today: ${t.title}`)];
      if (t.priority === 1) al.push(alarm("-PT4H", `Due tomorrow: ${t.title}`));
      // same heads-up window the app uses: explicit warn, else 7/3/1 days by priority
      const warn = t.warn != null && t.warn !== "" ? Number(t.warn) || 0 : ({ 1: 7, 2: 3, 3: 1 } as Record<number, number>)[t.priority || 3] ?? 1;
      if (warn > 0) al.push(alarm(`-PT${warn * 24 - 9}H`, `Heads-up, due in ${warn} day${warn > 1 ? "s" : ""}: ${t.title}`));
      event(`task-${t.id}`, t.due, tag + t.title, desc, al);
    }
    const planned = t.mustWinOn || t.todayOn;
    if (planned && planned >= cutoff && planned !== t.due) {
      event(`plan-${t.id}-${planned}`, planned, (t.mustWinOn ? "★ Must-win: " : "Planned: ") + tag + t.title, desc, [alarm("PT8H30M", `On today's plan: ${t.title}`)]);
    }
  }
  for (const [id, p] of Object.entries(projects)) {
    if (!p.deadline || p.deadline < cutoff || p.archived) continue;
    event(`proj-${id}`, p.deadline, `🏁 Deadline: ${p.name}`, p.goal || "", [alarm("PT9H", `Project deadline today: ${p.name}`), alarm("-P2DT15H", `Project deadline in 3 days: ${p.name}`)]);
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache", "Content-Disposition": 'inline; filename="quest-deck.ics"' },
  });
});
