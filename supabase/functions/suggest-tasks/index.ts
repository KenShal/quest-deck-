// Quest Deck: turns a project description into suggested first tasks, using Claude.
// POST /functions/v1/suggest-tasks  { name, description, deadline?, area?, today?, existing?: string[] }
// Needs a signed-in user (the gateway checks the JWT) and ONE of these secrets set in Supabase:
//   ANTHROPIC_API_KEY (Claude, paid)   or   GEMINI_API_KEY (Google Gemini, has a free tier; optional GEMINI_MODEL).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const KINDS = ["event", "meeting", "call", "online", "outside", "focus", "home"];

const SYSTEM = `You are a practical project planner inside a personal task app. The user describes a project. Reply with the concrete tasks needed to move it forward.

Return ONLY valid JSON, no prose, in this exact shape:
{"tasks":[{"title":string,"kind":string|null,"size":"S"|"M"|"L","priority":1|2|3,"dueInDays":number|null,"urgent":boolean,"important":boolean}]}

Rules:
- 6 to 12 tasks, ordered in the sequence they should happen.
- Each title is a concrete next action that starts with a verb, under 70 characters. No vague items like "Plan project".
- kind is one of: event, meeting, call, online, outside, focus, home. Use null if none fits. "event" only for a real occasion that takes the whole day.
- size: S is about 15 minutes, M about 30, L an hour or more.
- priority: 1 critical, 2 important, 3 normal. Use 1 sparingly.
- dueInDays: days from today when it should be done, spread sensibly before the deadline if one is given; null if no date makes sense.
- urgent means it needs doing soon; important means it matters for the outcome.
- Do not repeat tasks listed under "Already planned".
- Write in the same language as the description.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  const gkey = Deno.env.get("GEMINI_API_KEY");
  if (!key && !gkey) return json({ error: "no_key" }, 501);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const name = String(b?.name ?? "").slice(0, 200).trim();
  const description = String(b?.description ?? "").slice(0, 4000).trim();
  if (!name && !description) return json({ error: "empty" }, 400);
  const existing = Array.isArray(b?.existing) ? b.existing.slice(0, 40).map((x: unknown) => String(x).slice(0, 120)) : [];
  const user = [
    `Project: ${name || "(unnamed)"}`,
    b?.area ? `Area: ${String(b.area).slice(0, 40)}` : "",
    b?.today ? `Today: ${String(b.today).slice(0, 10)}` : "",
    b?.deadline ? `Deadline: ${String(b.deadline).slice(0, 10)}` : "No deadline set.",
    `Description:\n${description || "(none given)"}`,
    existing.length ? `Already planned:\n- ${existing.join("\n- ")}` : "",
  ].filter(Boolean).join("\n");

  let text = "";
  if (key) {
    let r: Response;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1800, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      });
    } catch { return json({ error: "upstream" }, 502); }
    if (r.status === 401 || r.status === 403) return json({ error: "bad_key" }, 502);
    if (r.status === 429) return json({ error: "busy" }, 429);
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
    const data = await r.json();
    text = (data?.content ?? []).map((c: any) => c?.text ?? "").join("");
  } else {
    // Google Gemini (free tier available): the key goes in a header, never in the URL
    const model = (Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest").replace(/[^\w.-]/g, "");
    let r: Response;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": gkey!, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1800, temperature: 0.4 },
        }),
      });
    } catch { return json({ error: "upstream" }, 502); }
    if (r.status === 400 || r.status === 401 || r.status === 403) return json({ error: "bad_key" }, 502);
    if (r.status === 429) return json({ error: "busy" }, 429);
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
    const data = await r.json();
    text = (data?.candidates?.[0]?.content?.parts ?? []).map((c: any) => c?.text ?? "").join("");
  }
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: any;
  try { parsed = JSON.parse(m ? m[0] : text); } catch { return json({ error: "parse" }, 502); }
  const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : []).slice(0, 14).map((t: any) => ({
    title: String(t?.title ?? "").slice(0, 120).trim(),
    kind: KINDS.includes(t?.kind) ? t.kind : null,
    size: ["S", "M", "L"].includes(t?.size) ? t.size : "M",
    priority: [1, 2, 3].includes(Number(t?.priority)) ? Number(t.priority) : 3,
    dueInDays: Number.isFinite(Number(t?.dueInDays)) && t?.dueInDays !== null ? Math.max(0, Math.min(365, Math.round(Number(t.dueInDays)))) : null,
    urgent: !!t?.urgent,
    important: !!t?.important,
  })).filter((t: any) => t.title);
  if (!tasks.length) return json({ error: "parse" }, 502);
  return json({ tasks });
});
