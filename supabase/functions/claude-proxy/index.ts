// claude-proxy — Supabase Edge Function
//
// Tunn proxy mellan Rutt-scanner-appen och Anthropic Messages API.
// Anledning: appen ligger på ett PUBLIKT GitHub Pages-repo, så en API-nyckel
// får aldrig ligga i index.html (den skulle synas för alla, autospärras av
// GitHub/Anthropic secret scanning och kunna missbrukas).
//
// Funktionen lägger till nyckeln SERVERSIDE och vidarebefordrar appens body
// oförändrad till Anthropic, samt returnerar svaret verbatim (samma JSON-form
// och statuskoder) så att appens befintliga parsning/felhantering kan stå kvar.
//
// Sätt nyckeln som en hemlighet i Supabase:
//   Project Settings → Edge Functions → Secrets → ANTHROPIC_API_KEY = sk-ant-…
// och begränsa den med en spend-/spärrgräns i Anthropic Console.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: "Proxy saknar ANTHROPIC_API_KEY" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const body = await req.text(); // vidarebefordra appens body oförändrad

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body,
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
