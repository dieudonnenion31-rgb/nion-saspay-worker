/**
 * Worker Cloudflare — passerelle sécurisée entre Nion Market et l'API SasPay.
 * La clé API SasPay reste ici (en secret côté serveur), jamais dans index.html.
 *
 * Basé sur la doc officielle SasPay (docs.saspay.me) :
 * - Base URL : https://api.saspay.me/api/v1
 * - Création de paiement : POST /payments/softpay/ (avec Idempotency-Key)
 * - Vérification : GET /payments/{id}/verify/ — ne jamais faire confiance à
 *   un simple délai, le statut de succès réel est la chaîne "SUCCESS".
 * - Montant : chaîne décimale ("2500.00"), jamais un nombre flottant.
 * - On n'envoie pas de "network" : SasPay retourne alors un checkout_url
 *   (page hébergée) où le client choisit lui-même Orange/Moov/carte.
 */

const ALLOWED_ORIGIN = "*"; // À remplacer plus tard par votre domaine exact si besoin
const SASPAY_BASE_URL = "https://api.saspay.me/api/v1";

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

// Crée un paiement SasPay. Sans "network" précisé, SasPay renvoie un
// checkout_url : une page hébergée où le client choisit son réseau et paie.
async function createPayment(env, { amount, description, customerEmail, customerFirstName, customerLastName, customerPhone }){
  const idempotencyKey = crypto.randomUUID();
  const res = await fetch(`${SASPAY_BASE_URL}/payments/softpay/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SASPAY_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      amount: Number(amount).toFixed(2), // doit être une chaîne décimale, ex "2500.00"
      currency: "XOF",
      country: "BF",
      description: description || "Commande Nion Market",
      customer: {
        email: customerEmail || "client@nionmarket.com",
        first_name: customerFirstName || "Client",
        last_name: customerLastName || "Nion Market",
        phone: customerPhone || ""
      }
    })
  });
  const data = await res.json();
  return { ok: res.status === 201, data };
}

// Vérifie le vrai statut d'un paiement — jamais de confiance en un simple délai.
async function verifyPayment(env, paymentId){
  const res = await fetch(`${SASPAY_BASE_URL}/payments/${encodeURIComponent(paymentId)}/verify/`, {
    headers: { "Authorization": `Bearer ${env.SASPAY_API_KEY}` }
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }

    if(url.pathname === "/pay" && request.method === "POST"){
      try{
        const body = await request.json();
        const { amount, description, customerEmail, customerFirstName, customerLastName, customerPhone } = body;
        if(!amount || Number(amount) <= 0){ return json({ error: "amount requis" }, 400); }

        const { ok, data } = await createPayment(env, { amount, description, customerEmail, customerFirstName, customerLastName, customerPhone });
        if(!ok){ return json({ error: "saspay_error", details: data }, 502); }

        return json({
          id: data.id || data.payment_id,
          checkout_url: data.checkout_url || null,
          status: data.status || "PENDING"
        });
      }catch(err){
        return json({ error: "invalid_request", message: String(err) }, 400);
      }
    }

    if(url.pathname === "/status" && request.method === "GET"){
      const id = url.searchParams.get("id");
      if(!id){ return json({ error: "id manquant" }, 400); }
      try{
        const { ok, data } = await verifyPayment(env, id);
        if(!ok){ return json({ error: "saspay_error", details: data }, 502); }
        // "SUCCESS" est l'unique statut à considérer comme un paiement confirmé.
        return json({ status: data.status, raw: data });
      }catch(err){
        return json({ error: "invalid_request", message: String(err) }, 400);
      }
    }

    return json({ error: "not_found" }, 404);
  }
};
      
