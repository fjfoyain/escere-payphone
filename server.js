import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ⚠️ Ajusta orígenes permitidos a tu dominio
app.use(cors({ origin: ["https://escere.com", "https://www.escere.com"] }));

// === ENV ===
const {
  PAYPHONE_TOKEN,          // token de app WEB Payphone
  PAYPHONE_STORE_ID,       // storeId de Payphone (usado en la Cajita)
  SHOPIFY_SHOP,            // ej: "escere.myshopify.com"
  SHOPIFY_ADMIN_TOKEN,     // Admin API token
  FRONT_PAY_PAGE_URL,      // ej: "https://escere.com/pages/pagar-payphone"
  SUCCESS_URL              // ej: "https://escere.com/pages/gracias-pago"
} = process.env;

// Helper Shopify GraphQL
const shopifyGraphql = async (query, variables = {}) => {
  const resp = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (json.errors || json.data?.userErrors?.length) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
};

// 1) Iniciar pago: crea Draft Order y redirige a página con Cajita
app.post("/payphone/create", async (req, res) => {
  try {
    const { items = [], email = "", currency = "USD", total_cents = 0 } = req.body;
    if (!items.length || total_cents <= 0) {
      return res.status(400).json({ error: "Carrito vacío o total inválido" });
    }

    // Mapea ítems a DraftOrder (precio en USD)
    const lineItems = items.map(i => ({
      quantity: i.quantity,
      originalUnitPrice: (i.price_cents / 100.0).toFixed(2),
      title: i.title
    }));

    const createMutation = `
      mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;
    const input = {
      email: email || undefined,
      currencyCode: currency,
      lineItems,
      tags: ["payphone"]
    };
    const dataCreate = await shopifyGraphql(createMutation, { input });
    const draftId = dataCreate.draftOrderCreate.draftOrder.id; // gid://shopify/DraftOrder/<id>
    const numericDraftId = draftId.split("/").pop();

    const clientTransactionId = `do${numericDraftId}_${Date.now()}`;

    const redirectUrl = `${FRONT_PAY_PAGE_URL}?tid=${encodeURIComponent(clientTransactionId)}&amount_cents=${total_cents}&amount_with_tax_cents=${total_cents}&tax_cents=0`;
    return res.json({ redirectUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
});

// 2) Confirmación: Payphone → Confirm API → completar DraftOrder
app.get("/payphone/confirm", async (req, res) => {
  try {
    const id = parseInt(req.query.id || "0", 10);
    const clientTxId = req.query.clientTransactionId || "";
    if (!id || !clientTxId) return res.status(400).send("Parámetros inválidos");

    // Confirmación Payphone
    const confResp = await fetch("https://pay.payphonetodoesposible.com/api/button/V2/Confirm", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PAYPHONE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id, clientTxId })
    });
    const conf = await confResp.json();
    const approved = conf?.statusCode === 3;
    if (!approved) {
      return res.redirect(`${SUCCESS_URL}?status=failed&tid=${encodeURIComponent(clientTxId)}&msg=${encodeURIComponent(conf?.message || "Pago cancelado")}`);
    }

    // Extrae draftId de clientTxId: do<id>_<ts>
    const m = clientTxId.match(/^do(\d+)_/);
    if (!m) return res.redirect(`${SUCCESS_URL}?status=error&reason=bad_tid`);
    const draftNumericId = m[1];
    const draftGid = `gid://shopify/DraftOrder/${draftNumericId}`;

    // Completa DraftOrder -> Order
    const completeMutation = `
      mutation($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;
    const completeData = await shopifyGraphql(completeMutation, { id: draftGid });
    const order = completeData.draftOrderComplete?.draftOrder?.order;
    const orderName = order?.name || "";

    return res.redirect(`${SUCCESS_URL}?status=success&order=${encodeURIComponent(orderName)}&tid=${encodeURIComponent(clientTxId)}&auth=${encodeURIComponent(conf?.authorizationCode || "")}`);
  } catch (e) {
    console.error("Error confirm:", e);
    return res.redirect(`${SUCCESS_URL}?status=error`);
  }
});

// (Opcional) 3) Webhook/Notificación Externa de Payphone
app.post("/payphone/notify", async (req, res) => {
  try {
    // Valida firma si Payphone envía headers de verificación.
    // Guarda/actualiza estado del pago en tu DB si lo necesitas.
    console.log("Webhook Payphone:", req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("notify", e);
    res.sendStatus(500);
  }
});

app.get("/", (_req, res) => res.send("OK"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on", port));