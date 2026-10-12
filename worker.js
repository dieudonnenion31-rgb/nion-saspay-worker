/**
 * Worker Cloudflare — passerelle sécurisée entre Nion Market et l'API SasPay.
 * La clé API SasPay reste ici (secret SASPAY_API_KEY), jamais dans index.html.
 *
 * Basé sur la doc officielle SasPay (docs.saspay.me) :
 * - Base URL : https://api.saspay.me/api/v1
 * - Page de paiement hébergée : POST /checkout-sessions/ -> data.checkout_url
 * - Statut d'une session : GET /checkout-sessions/{id}/status/
 * - Toutes les réponses sont enveloppées : { success, data: {...}, code }
 * - Montant : chaîne décimale ("5000.00"), jamais un nombre flottant.
 */

const ALLOWED_ORIGIN = "*";
const SASPAY_BASE_URL = "https://api.saspay.me/api/v1";
const RETURN_URL = "https://nion-market-boutique1.netlify.app/";

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200){
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// Enveloppe SasPay : le contenu utile est dans "data".
function unwrap(body){
  return (body && body.data) ? body.data : (body || {});
}

async function createCheckoutSession(env, { amount, description, customerEmail, customerName }){
  const res = await fetch(`${SASPAY_BASE_URL}/checkout-sessions/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SASPAY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: Number(amount).toFixed(2),
      currency: "XOF",
      description: description || "Commande Nion Market",
      customer_email: customerEmail || "client@nionmarket.com",
      customer_name: customerName || "Client Nion Market",
      return_url: RETURN_URL
    })
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function getCheckoutStatus(env, sessionId){
  const res = await fetch(`${SASPAY_BASE_URL}/checkout-sessions/${encodeURIComponent(sessionId)}/status/`, {
    headers: { "Authorization": `Bearer ${env.SASPAY_API_KEY}` }
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }

    if(!env.SASPAY_API_KEY){
      return json({ error: "config_missing", message: "Clé SasPay non configurée sur le Worker" }, 500);
    }

    if(url.pathname === "/pay" && request.method === "POST"){
      try{
        const body = await request.json();
        const { amount, description, customerFirstName, customerLastName } = body;
        if(!amount || Number(amount) <= 0){ return json({ error: "amount_invalid" }, 400); }

        const customerName = `${customerFirstName || ""} ${customerLastName || ""}`.trim() || "Client Nion Market";
        const r = await createCheckoutSession(env, { amount, description, customerName });
        const payload = unwrap(r.body);

        if(!r.ok || !payload.id || !payload.checkout_url){
          return json({
            error: "saspay_error",
            saspayStatus: r.status,
            message: payload.message || (r.body && r.body.message) || "Réponse SasPay incomplète"
          }, 502);
        }

        return json({ id: payload.id, checkout_url: payload.checkout_url, status: payload.status || "PENDING" });
      }catch(err){
        return json({ error: "invalid_request", message: String(err) }, 400);
      }
    }

    if(url.pathname === "/status" && request.method === "GET"){
      const id = url.searchParams.get("id");
      if(!id){ return json({ error: "id_missing" }, 400); }
      try{
        const r = await getCheckoutStatus(env, id);
        if(!r.ok){ return json({ error: "saspay_error", saspayStatus: r.status }, 502); }
        const payload = unwrap(r.body);
        return json({ status: String(payload.status || "").toUpperCase() });
      }catch(err){
        return json({ error: "invalid_request", message: String(err) }, 400);
      }
    }

    return json({ error: "not_found" }, 404);
  }
};
    
