// app-auth — Supabase Edge Function
//
// Verifierar lösenord för rutt-scanner-appen (index.html).
// Secrets som krävs (Project Settings → Edge Functions → Secrets):
//   APP_PASSWORD = <lösenord du väljer>
//
// Deploy: supabase functions deploy app-auth --no-verify-jwt

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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

  const appPassword = Deno.env.get("APP_PASSWORD");
  if (!appPassword) {
    return jsonResponse({ ok: false, error: "Proxy saknar APP_PASSWORD" }, 500);
  }

  let payload: { password?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Ogiltig JSON" }, 400);
  }

  const { password } = payload;
  if (!password || !timingSafeEqual(password, appPassword)) {
    return jsonResponse({ ok: false, error: "Fel lösenord" }, 401);
  }

  return jsonResponse({ ok: true });
});
