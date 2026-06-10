// admin-stats — Supabase Edge Function
//
// Server-side stöd för den privata kontrollpanelen (admin.html).
// Lösenordsskyddad (ADMIN_PASSWORD-secret) och använder service-rollen
// för att läsa/underhålla all data, oavsett RLS — precis som claude-proxy
// håller Anthropic-nyckeln server-side håller den här funktionen
// service-nyckeln server-side.
//
// Secrets som krävs (Project Settings → Edge Functions → Secrets):
//   ADMIN_PASSWORD = <lösenord du väljer>
// SUPABASE_URL och SUPABASE_SERVICE_ROLE_KEY injiceras automatiskt.
//
// Deploy: supabase functions deploy admin-stats --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Tabeller som får bläddras i via "table"-action. scan_images.image_data
// (tunga base64-blobbar) exkluderas alltid.
const TABLE_CONFIG: Record<string, { orderBy: string; columns: string }> = {
  route_entries:    { orderBy: "created_at",  columns: "*" },
  scan_images:      { orderBy: "created_at",  columns: "id, created_at" },
  search_logs:      { orderBy: "searched_at", columns: "*" },
  scan_logs:        { orderBy: "scanned_at",  columns: "*" },
  judge_logs:       { orderBy: "scanned_at",  columns: "*" },
  session_segments: { orderBy: "segment_start", columns: "*" },
  daily_unit_totals:{ orderBy: "entry_date",  columns: "*" },
  scan_history:     { orderBy: "scanned_at",  columns: "*" },
  audit_log:        { orderBy: "occurred_at", columns: "*" },
  split_decisions:  { orderBy: "scanned_at",  columns: "*" },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Konstant-tids strängjämförelse (skydd mot timing-attacker på lösenordet).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Endast POST" }, 405);
  }

  const adminPassword = Deno.env.get("ADMIN_PASSWORD");
  if (!adminPassword) {
    return jsonResponse({ ok: false, error: "Proxy saknar ADMIN_PASSWORD" }, 500);
  }

  let payload: { password?: string; action?: string; params?: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Ogiltig JSON" }, 400);
  }

  const { password, action, params = {} } = payload;
  if (!password || !timingSafeEqual(password, adminPassword)) {
    return jsonResponse({ ok: false, error: "Fel lösenord" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  try {
    switch (action) {
      case "overview":
        return jsonResponse({ ok: true, data: await getOverview(sb) });

      case "ai_quality":
        return jsonResponse({ ok: true, data: await getAiQuality(sb) });

      case "table":
        return jsonResponse({ ok: true, data: await getTable(sb, params) });

      case "audit":
        return jsonResponse({ ok: true, data: await getAudit(sb, params) });

      case "delete_kof":
        return jsonResponse({ ok: true, data: await deleteKof(sb, params) });

      case "delete_route":
        return jsonResponse({ ok: true, data: await deleteRoute(sb, params) });

      case "clear_all":
        return jsonResponse({ ok: true, data: await clearAll(sb) });

      default:
        return jsonResponse({ ok: false, error: `Okänd action: ${action}` }, 400);
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err?.message ?? err) }, 500);
  }
});

async function getOverview(sb: ReturnType<typeof createClient>) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const since24h = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    lastScan,
    lastSearch,
    activeDevicesToday,
    failedSearches24h,
    failedSearches7d,
    judgeFailed7d,
    todayTotals,
    searchPerf,
    searchTrend,
  ] = await Promise.all([
    sb.from("scan_logs").select("scanned_at").order("scanned_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("search_logs").select("searched_at").order("searched_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("search_logs").select("device_id").gte("searched_at", `${todayStr}T00:00:00Z`),
    sb.from("search_logs").select("id", { count: "exact", head: true }).eq("success", false).gte("searched_at", since24h),
    sb.from("search_logs").select("id", { count: "exact", head: true }).eq("success", false).gte("searched_at", since7d),
    sb.from("judge_logs").select("id", { count: "exact", head: true }).eq("approved", false).gte("scanned_at", since7d),
    sb.from("daily_unit_totals").select("*").eq("entry_date", todayStr).maybeSingle(),
    sb.from("search_performance_stats").select("*").maybeSingle(),
    sb.from("search_performance_daily").select("*").limit(14),
  ]);

  const activeDeviceCount = new Set(
    (activeDevicesToday.data ?? []).map((r: { device_id: string }) => r.device_id),
  ).size;

  return {
    last_scan_at: lastScan.data?.scanned_at ?? null,
    last_search_at: lastSearch.data?.searched_at ?? null,
    active_devices_today: activeDeviceCount,
    failed_searches_24h: failedSearches24h.count ?? 0,
    failed_searches_7d: failedSearches7d.count ?? 0,
    judge_not_approved_7d: judgeFailed7d.count ?? 0,
    today_totals: todayTotals.data ?? null,
    search_performance: searchPerf.data ?? null,
    search_trend: searchTrend.data ?? [],
  };
}

async function getAiQuality(sb: ReturnType<typeof createClient>) {
  const [judgeStats, splitStats] = await Promise.all([
    sb.from("judge_quality_stats").select("*").maybeSingle(),
    sb.from("split_decision_stats").select("*").maybeSingle(),
  ]);
  return {
    judge: judgeStats.data ?? null,
    split: splitStats.data ?? null,
  };
}

async function getTable(sb: ReturnType<typeof createClient>, params: Record<string, unknown>) {
  const table = String(params.table ?? "");
  const config = TABLE_CONFIG[table];
  if (!config) throw new Error(`Okänd tabell: ${table}`);

  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const offset = Math.max(Number(params.offset) || 0, 0);

  const { data, count, error } = await sb
    .from(table)
    .select(config.columns, { count: "exact" })
    .order(config.orderBy, { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return { rows: data ?? [], total: count ?? 0, limit, offset };
}

async function getAudit(sb: ReturnType<typeof createClient>, params: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const { data, error } = await sb
    .from("audit_log")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { rows: data ?? [] };
}

async function logAdminAudit(
  sb: ReturnType<typeof createClient>,
  rows: Record<string, unknown>[],
) {
  await sb.from("audit_log").insert(rows.map((r) => ({ ...r, device_id: "admin-panel" })));
}

async function deleteKof(sb: ReturnType<typeof createClient>, params: Record<string, unknown>) {
  const kof = String(params.kof ?? "");
  if (!/^\d{6}$/.test(kof)) throw new Error("Ogiltigt KOF-nummer");

  const { data: existing } = await sb.from("route_entries").select("kof, route, scan_image_id").eq("kof", kof).maybeSingle();
  if (!existing) throw new Error("KOF hittades inte");

  const { error } = await sb.from("route_entries").delete().eq("kof", kof);
  if (error) throw error;

  if (existing.scan_image_id) {
    const { count } = await sb
      .from("route_entries")
      .select("kof", { count: "exact", head: true })
      .eq("scan_image_id", existing.scan_image_id);
    if (!count) {
      await sb.from("scan_images").delete().eq("id", existing.scan_image_id);
    }
  }

  await logAdminAudit(sb, [{
    action: "delete_kof",
    kof,
    route: existing.route,
    old_value: existing.route,
    new_value: null,
    occurred_at: new Date().toISOString(),
  }]);

  return { deleted: kof };
}

async function deleteRoute(sb: ReturnType<typeof createClient>, params: Record<string, unknown>) {
  const route = String(params.route ?? "");
  if (!route) throw new Error("Rutt saknas");

  const { data: existing, error: selectErr } = await sb
    .from("route_entries")
    .select("kof, scan_image_id")
    .eq("route", route);
  if (selectErr) throw selectErr;
  if (!existing || existing.length === 0) throw new Error("Rutten hittades inte");

  const { error } = await sb.from("route_entries").delete().eq("route", route);
  if (error) throw error;

  const imageIds = [...new Set(existing.map((r) => r.scan_image_id).filter(Boolean))];
  for (const imageId of imageIds) {
    const { count } = await sb
      .from("route_entries")
      .select("kof", { count: "exact", head: true })
      .eq("scan_image_id", imageId as string);
    if (!count) {
      await sb.from("scan_images").delete().eq("id", imageId as string);
    }
  }

  await logAdminAudit(sb, [{
    action: "delete_route",
    kof: null,
    route,
    old_value: route,
    new_value: null,
    occurred_at: new Date().toISOString(),
  }]);

  return { deleted_route: route, kof_count: existing.length };
}

async function clearAll(sb: ReturnType<typeof createClient>) {
  const { count: routeCount } = await sb.from("route_entries").select("kof", { count: "exact", head: true });
  const { count: imageCount } = await sb.from("scan_images").select("id", { count: "exact", head: true });

  const { error: routeErr } = await sb.from("route_entries").delete().not("kof", "is", null);
  if (routeErr) throw routeErr;

  const { error: imageErr } = await sb.from("scan_images").delete().not("id", "is", null);
  if (imageErr) throw imageErr;

  await logAdminAudit(sb, [{
    action: "clear_all",
    kof: null,
    route: null,
    old_value: `route_entries=${routeCount ?? 0}, scan_images=${imageCount ?? 0}`,
    new_value: null,
    occurred_at: new Date().toISOString(),
  }]);

  return { cleared_route_entries: routeCount ?? 0, cleared_scan_images: imageCount ?? 0 };
}
