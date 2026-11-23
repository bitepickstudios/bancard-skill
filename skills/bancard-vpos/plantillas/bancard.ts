// Cliente mínimo de Bancard vPOS 2.0 (API 0.3). Sin dependencias: Node 18+ (fetch y node:crypto).
// Copiar a lib/bancard.ts. SÓLO SERVIDOR: firma con la clave privada.
//
// Env:
//   BANCARD_PUBLIC_KEY, BANCARD_PRIVATE_KEY   (portal de comercios → perfil de la aplicación)
//   BANCARD_ENV = sandbox | production        (default sandbox)
import { createHash, timingSafeEqual } from "node:crypto";

export type BancardOperation = {
  shop_process_id?: string | number | null;
  response?: string | null; // "S" = la API PROCESÓ el pedido. NO significa aprobado.
  response_code?: string | null; // "00" = aprobado. Cualquier otro código = rechazo.
  response_description?: string | null;
  authorization_number?: string | null; // vacío/null si no hubo aprobación
  ticket_number?: string | null;
  amount?: string | number | null;
  currency?: string | null;
  token?: string | null;
  process_id?: string | null; // charge con 3DS: viene acá y el resto en null
  extra_attributes?: { payment_card_type?: string | null } | null;
  [k: string]: unknown;
};

export type BancardCard = {
  alias_token: string;
  card_id: number;
  card_masked_number: string;
  card_brand: string;
  expiration_date: string;
  card_type?: string;
};

export type BancardResponse = {
  status?: "success" | "error" | string;
  messages?: { key: string; level?: string; dsc: string }[];
  process_id?: string;
  operation?: BancardOperation;
  confirmation?: BancardOperation;
  cards?: BancardCard[];
  [k: string]: unknown;
};

const CURRENCY = "PYG"; // vPOS sólo opera en guaraníes

function config() {
  const publicKey = process.env.BANCARD_PUBLIC_KEY;
  const privateKey = process.env.BANCARD_PRIVATE_KEY;
  if (!publicKey || !privateKey) throw new Error("Bancard: faltan BANCARD_PUBLIC_KEY / BANCARD_PRIVATE_KEY");
  const host =
    process.env.BANCARD_ENV === "production" ? "https://vpos.infonet.com.py" : "https://vpos.infonet.com.py:8888";
  return { publicKey, privateKey, api: `${host}/vpos/api/0.3`, checkout: `${host}/checkout/new` };
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** 150000 → "150000.00". El guaraní no tiene centavos: NUNCA dividir por 100. */
export const formatAmount = (n: number | string) => Number(n).toFixed(2);

/** Monto saliente: guaraníes enteros. Redondeá vos (p. ej. tras convertir de USD) antes de llamar. */
function pyg(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Bancard: el monto debe ser guaraníes enteros > 0: ${n}`);
  return n.toFixed(2);
}

/** shop_process_id: entero de hasta 15 dígitos, único en el comercio y nunca reutilizado. */
function spid(id: number | string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n).length > 15) throw new Error(`Bancard: shop_process_id inválido: ${id}`);
  return n;
}

async function call(path: string, operation: Record<string, unknown>, method = "POST"): Promise<BancardResponse> {
  const { publicKey, api } = config();
  const res = await fetch(`${api}/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: publicKey, operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  try {
    return JSON.parse(raw) as BancardResponse;
  } catch {
    throw new Error(`Bancard ${path} HTTP ${res.status}: respuesta no JSON — ${raw.slice(0, 300)}`);
  }
}

const describe = (r: BancardResponse) =>
  r.messages?.map((m) => `${m.key}: ${m.dsc}`).join(", ") || JSON.stringify(r).slice(0, 300);

/**
 * EL criterio de aprobación. Usar esta función en TODOS los sitios que deciden si se cobró
 * (webhook, cron, charge, reintentos). Nunca reescribirlo inline.
 */
export function isApproved(op: BancardOperation | null | undefined): boolean {
  return op?.response === "S" && op?.response_code === "00" && !!op?.authorization_number;
}

/** Inicia un pago ocasional. Devuelve el process_id para montar el iframe (o redirigir). */
export async function singleBuy(p: {
  shopProcessId: number | string;
  amount: number;
  description: string; // máx 20 caracteres, se recorta
  returnUrl: string;
  cancelUrl?: string;
}): Promise<{ processId: string; redirectUrl: string }> {
  const { privateKey, checkout } = config();
  const id = spid(p.shopProcessId);
  const amount = pyg(p.amount);
  const description = p.description.trim().slice(0, 20);
  if (!description) throw new Error("Bancard: description obligatoria");
  const r = await call("single_buy", {
    token: md5(`${privateKey}${id}${amount}${CURRENCY}`),
    shop_process_id: id,
    amount,
    currency: CURRENCY,
    description,
    return_url: p.returnUrl,
    cancel_url: p.cancelUrl ?? p.returnUrl,
    extra_response_attributes: ["payment_card_type"], // llega en operation.extra_attributes.payment_card_type
  });
  if (r.status !== "success" || !r.process_id) throw new Error(`Bancard single_buy: ${describe(r)}`);
  return { processId: r.process_id, redirectUrl: `${checkout}?process_id=${r.process_id}` };
}

/**
 * Valida la firma del POST de confirmación (webhook). Sin firma válida el body no prueba
 * nada: cualquiera puede postear un JSON con response_code "00".
 * Bancard firma el monto con dos decimales ("150000.00", igual que lo manda); formatAmount
 * lo deja tal cual y normaliza si llegara como número.
 */
export function verifyConfirmation(op: BancardOperation | null | undefined): boolean {
  if (!op?.token || op.shop_process_id == null || op.amount == null || !op.currency) return false;
  const { privateKey } = config();
  const expected = md5(`${privateKey}${op.shop_process_id}confirm${formatAmount(op.amount)}${op.currency}`);
  const got = String(op.token).toLowerCase();
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * Consulta a Bancard el estado real de una compra. Ante cualquier duda (webhook que no llegó,
 * auditoría, reclamo del cliente) la verdad es esta, no tu base de datos.
 * Devuelve la respuesta cruda: la operación viene en `confirmation` u `operation`.
 */
export async function getConfirmation(shopProcessId: number | string): Promise<BancardResponse> {
  const { privateKey } = config();
  const id = spid(shopProcessId);
  return call("single_buy/confirmations", { token: md5(`${privateKey}${id}get_confirmation`), shop_process_id: id });
}

export const confirmationOp = (r: BancardResponse) => r.confirmation ?? r.operation ?? null;

/**
 * Anula una compra. Sólo funciona el mismo día y antes de que esté cuponada.
 * messages[0].key: RollbackSuccessful | AlreadyRollbackedError | TransactionAlreadyConfirmed
 * (cuponada → anulación manual por portal de comercios → Soporte → Anulaciones).
 */
export async function rollback(shopProcessId: number | string): Promise<BancardResponse> {
  const { privateKey } = config();
  const id = spid(shopProcessId);
  return call("single_buy/rollback", { token: md5(`${privateKey}${id}rollback0.00`), shop_process_id: id });
}

// ── Pago con token (tarjetas guardadas) ──────────────────────────────────────────────

/**
 * Catastro de tarjeta. card_id es GLOBAL del comercio (no por usuario): usar un id único por
 * catastro, nunca un rango chico reciclable. Máx 5 tarjetas por user_id.
 */
export async function cardsNew(p: {
  cardId: number;
  userId: number;
  userCellPhone: string;
  userMail: string;
  returnUrl: string;
}): Promise<string> {
  const { privateKey } = config();
  const r = await call("cards/new", {
    token: md5(`${privateKey}${p.cardId}${p.userId}request_new_card`),
    card_id: p.cardId,
    user_id: p.userId,
    user_cell_phone: p.userCellPhone,
    user_mail: p.userMail,
    return_url: p.returnUrl,
  });
  if (r.status !== "success" || !r.process_id) throw new Error(`Bancard cards/new: ${describe(r)}`);
  return r.process_id; // → Bancard.Cards.createForm(container, processId, options)
}

/** Tarjetas del usuario según Bancard. Tu tabla local es una copia: reconstruirla con upsert. */
export async function userCards(userId: number): Promise<BancardCard[]> {
  const { privateKey } = config();
  const r = await call(`users/${userId}/cards`, { token: md5(`${privateKey}${userId}request_user_cards`) });
  if (r.status !== "success") throw new Error(`Bancard users/cards: ${describe(r)}`);
  return r.cards ?? [];
}

export async function deleteCard(userId: number, aliasToken: string): Promise<BancardResponse> {
  const { privateKey } = config();
  return call(
    `users/${userId}/cards`,
    { token: md5(`${privateKey}delete_card${userId}${aliasToken}`), alias_token: aliasToken },
    "DELETE"
  );
}

/**
 * Cobro con tarjeta guardada. Dos salidas posibles en r.operation:
 *  - sin 3DS: isApproved(r.operation) decide, igual que el webhook.
 *  - con 3DS: r.operation.process_id viene con valor y lo demás en null →
 *    montar Bancard.Charge3DS.createForm(container, processId, options) y esperar el webhook.
 * NO reintentar automáticamente un rechazo: 7 rechazos de la misma tarjeta en 24 h la bloquean
 * 30 días en el comercio.
 */
export async function charge(p: {
  shopProcessId: number | string;
  amount: number;
  aliasToken: string;
  description: string;
  returnUrl: string;
  numberOfPayments?: number;
}): Promise<BancardResponse> {
  const { privateKey } = config();
  const id = spid(p.shopProcessId);
  const amount = pyg(p.amount);
  return call("charge", {
    token: md5(`${privateKey}${id}charge${amount}${CURRENCY}${p.aliasToken}`),
    shop_process_id: id,
    amount,
    currency: CURRENCY,
    description: p.description.trim().slice(0, 20),
    number_of_payments: p.numberOfPayments ?? 1,
    alias_token: p.aliasToken,
    return_url: p.returnUrl,
    additional_data: "",
    extra_response_attributes: ["confirmation.process_id"],
  });
}
