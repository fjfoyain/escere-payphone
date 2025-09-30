import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Permite solo tu dominio público
app.use(cors({ origin: ["https://escere.com", "https://www.escere.com"] }));

// === ENV ===
const {
  PAYPHONE_TOKEN,          // Bearer Token (Payphone WEB app)
  PAYPHONE_STORE_ID,       // storeId (Payphone) - se usa en la cajita (front)
  SHOPIFY_SHOP,            // p.ej. escere-arte.myshopify.com (tu *.myshopify.com real)
  SHOPIFY_ADMIN_TOKEN,     // Admin API token (Shopify)
  FRONT_PAY_PAGE_URL,      // p.ej. https://escere.com/pages/pagar-payphone
  SUCCESS_URL              // p.ej. https://escere.com/pages/gracias-pago
} = process.env;

// --- helper Shopify GraphQL ---
const shopifyGraphql = async (query, variables = {}) => {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2025-07/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (!resp.ok || json.errors) {
    console.error("Shopify GraphQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
};

// ============= 1) CREATE: Crea DraftOrder a partir de variant_id/quantity =============
app.post("/payphone/create", async (req, res) => {
  try {
    const { items = [], email = "", currency = "USD" } = req.body;

    // Esperamos items: [{ variant_id, quantity }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Carrito vacío" });
    }

    // Construimos los lineItems usando variantId (seguro: precio lo pone Shopify)
    const lineItems = items.map(i => ({
      quantity: Number(i.quantity || 0),
      variantId: `gid://shopify/ProductVariant/${i.variant_id}`
    }));

    const createMutation = `
      mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            subtotalPriceSet { presentmentMoney { amount currencyCode } }
          }
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
    const draft = dataCreate?.draftOrderCreate?.draftOrder;
    if (!draft) throw new Error("No se pudo crear DraftOrder");

    const draftGid = draft.id; // gid://shopify/DraftOrder/XXXXXXXX
    const draftNumericId = draftGid.split("/").pop();

    // Tomamos el subtotal del draft como monto a cobrar
    const amountUsd = parseFloat(draft.subtotalPriceSet.presentmentMoney.amount || "0");
    const amountCents = Math.round(amountUsd * 100);
    if (!(amountCents > 0)) {
      // Si llegara 0, evita continuar (producto $0 o error de precios)
      return res.status(400).json({ error: "Total del pedido inválido (0)" });
    }

    // clientTransactionId único que referencia al draft
    const clientTransactionId = `do${draftNumericId}_${Date.now()}`;

    // Redirige a tu página con la cajita y montos en centavos
    const redirectUrl =
      `${FRONT_PAY_PAGE_URL}?tid=${encodeURIComponent(clientTransactionId)}` +
      `&amount_cents=${amountCents}&amount_with_tax_cents=${amountCents}&tax_cents=0`;

    return res.json({ redirectUrl });
  } catch (e) {
    console.error("create error:", e);
    return res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
});

// ============= 2) CONFIRM: Confirma con Payphone y completa el DraftOrder =============
app.get("/payphone/confirm", async (req, res) => {
  try {
    const id = parseInt(req.query.id || "0", 10);
    const clientTxId = req.query.clientTransactionId || "";

    if (!id || !clientTxId) {
      return res.status(400).send("Parámetros inválidos");
    }

    // Confirmación obligatoria con Payphone (status final)
    const confResp = await fetch("https://pay.payphonetodoesposible.com/api/button/V2/Confirm", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PAYPHONE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ id, clientTxId })
    });
    const conf = await confResp.json();
    const approved = conf?.statusCode === 3; // 3 = Approved

    if (!approved) {
      return res.redirect(
        `${SUCCESS_URL}?status=failed&tid=${encodeURIComponent(clientTxId)}&msg=${encodeURIComponent(conf?.message || "Pago cancelado")}`
      );
    }

    // Obtiene el id numérico del draft desde el TID: do<id>_<timestamp>
    const m = clientTxId.match(/^do(\d+)_/);
    if (!m) {
      return res.redirect(`${SUCCESS_URL}?status=error&reason=bad_tid`);
    }
    const draftNumericId = m[1];
    const draftGid = `gid://shopify/DraftOrder/${draftNumericId}`;

    // Completar el draft → crea Order (pagada)
    const completeMutation = `
      mutation($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;
    const completeData = await shopifyGraphql(completeMutation, { id: draftGid });
    const order = completeData?.draftOrderComplete?.draftOrder?.order;

    return res.redirect(
      `${SUCCESS_URL}?status=success&order=${encodeURIComponent(order?.name || "")}&tid=${encodeURIComponent(clientTxId)}&auth=${encodeURIComponent(conf?.authorizationCode || "")}`
    );
  } catch (e) {
    console.error("confirm error:", e);
    return res.redirect(`${SUCCESS_URL}?status=error`);
  }
});

// (opcional) Webhook/Notificación Externa de Payphone
app.post("/payphone/notify", async (req, res) => {
  try {
    console.log("Webhook Payphone:", req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("notify error:", e);
    res.sendStatus(500);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on", port));