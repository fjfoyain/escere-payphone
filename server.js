import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// CORS: solo tu dominio público
const ALLOWED = ["https://escere.com", "https://www.escere.com"];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED.includes(origin)),
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","X-Requested-With"]
}));
app.options("*", cors());

// === ENVs ===
const {
  PAYPHONE_TOKEN,          // Token Bearer de Payphone WEB app
  PAYPHONE_STORE_ID,       // storeId Payphone (para la Cajita en el front)
  SHOPIFY_SHOP,            // escere-arte.myshopify.com  (tu .myshopify.com activo)
  SHOPIFY_ADMIN_TOKEN,     // shpat_...  (token de la app de Admin API)
  FRONT_PAY_PAGE_URL,      // https://escere.com/pages/pagar-payphone
  SUCCESS_URL              // https://escere.com/pages/gracias-pago
} = process.env;

console.log("Using SHOPIFY_SHOP:", SHOPIFY_SHOP);

// Helper GraphQL Shopify con logs
const shopifyGraphql = async (query, variables = {}) => {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-10/graphql.json`; // versión estable
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error("Shopify HTTP error", resp.status, json);
    throw new Error(`Shopify HTTP ${resp.status}`);
  }
  if (json.errors) {
    console.error("Shopify GraphQL top-level errors:", JSON.stringify(json.errors, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
};

// ============= 1) CREATE: crea DraftOrder a partir de variant_id/quantity =============
app.post("/payphone/create", async (req, res) => {
  try {
    const { items = [], email = "" } = req.body;

    // Esperamos items: [{ variant_id, quantity }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Carrito vacío" });
    }

    const lineItems = items.map(i => ({
      quantity: Number(i.quantity || 0),
      variantId: `gid://shopify/ProductVariant/${i.variant_id}`
    }));

    // OJO: DraftOrderInput NO tiene currencyCode en 2024-10
    const createMutation = `
      mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            subtotalPriceSet { shopMoney { amount currencyCode } }  # usamos shopMoney
          }
          userErrors { field message }
        }
      }
    `;
    const input = {
      email: email || undefined,
      lineItems,
      tags: ["payphone"]
    };

    const dataCreate = await shopifyGraphql(createMutation, { input });

    const errs = dataCreate?.draftOrderCreate?.userErrors || [];
    if (errs.length) {
      console.error("draftOrderCreate userErrors:", errs);
      return res.status(400).json({ error: "Shopify draftOrderCreate", details: errs });
    }

    const draft = dataCreate?.draftOrderCreate?.draftOrder;
    if (!draft) return res.status(500).json({ error: "No se pudo crear DraftOrder" });

    const draftNumericId = draft.id.split("/").pop();

    // Tomamos el subtotal del draft (moneda de la tienda) y lo convertimos a centavos
    const amountUsd = parseFloat(draft.subtotalPriceSet.shopMoney.amount || "0");
    const amountCents = Math.round(amountUsd * 100);
    if (!(amountCents > 0)) {
      return res.status(400).json({ error: "Total del pedido inválido (0)" });
    }

    // clientTransactionId referencia al draft para usarlo en confirm
    const clientTransactionId = `do${draftNumericId}_${Date.now()}`;

    // Redirige a la página con la Cajita Payphone (montos en centavos)
    const redirectUrl =
      `${FRONT_PAY_PAGE_URL}?tid=${encodeURIComponent(clientTransactionId)}` +
      `&amount_cents=${amountCents}&amount_with_tax_cents=${amountCents}&tax_cents=0`;

    return res.json({ redirectUrl });
  } catch (e) {
    console.error("create error:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ============= 2) CONFIRM: confirma Payphone y completa el DraftOrder =============
app.get("/payphone/confirm", async (req, res) => {
  try {
    const id = parseInt(req.query.id || "0", 10);
    const clientTxId = req.query.clientTransactionId || "";
    if (!id || !clientTxId) return res.status(400).send("Parámetros inválidos");

    // Confirmación obligatoria con Payphone (estado final)
    const confResp = await fetch("https://pay.payphonetodoesposible.com/api/button/V2/Confirm", {
      method: "POST",
      headers: { "Authorization": `Bearer ${PAYPHONE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id, clientTxId })
    });
    const conf = await confResp.json();
    console.log("Payphone Confirm:", conf);

    const approved = conf?.statusCode === 3; // 3 = Approved
    if (!approved) {
      return res.redirect(`${SUCCESS_URL}?status=failed&tid=${encodeURIComponent(clientTxId)}&msg=${encodeURIComponent(conf?.message || "Pago cancelado")}`);
    }

    // DraftOrder gid desde el TID do<id>_<ts>
    const m = clientTxId.match(/^do(\d+)_/);
    if (!m) return res.redirect(`${SUCCESS_URL}?status=error&reason=bad_tid`);
    const draftGid = `gid://shopify/DraftOrder/${m[1]}`;

    const completeMutation = `
      mutation($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;
    const completeData = await shopifyGraphql(completeMutation, { id: draftGid });

    const errs = completeData?.draftOrderComplete?.userErrors || [];
    if (errs.length) {
      console.error("draftOrderComplete userErrors:", errs);
      return res.redirect(`${SUCCESS_URL}?status=error&reason=complete_userErrors`);
    }

    const order = completeData?.draftOrderComplete?.draftOrder?.order;
    return res.redirect(
      `${SUCCESS_URL}?status=success&order=${encodeURIComponent(order?.name || "")}` +
      `&tid=${encodeURIComponent(clientTxId)}&auth=${encodeURIComponent(conf?.authorizationCode || "")}`
    );
  } catch (e) {
    console.error("confirm error:", e);
    return res.redirect(`${SUCCESS_URL}?status=error`);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server on", port));