#!/usr/bin/env node
/**
 * Simula el POST de confirmación que Bancard hace a tu webhook, con firma MD5 válida.
 * Sirve para probar el webhook sin pagar de verdad.
 *
 *   node simular-webhook.mjs <shop_process_id> <monto_pyg> [flags]
 *
 * Flags:
 *   --rechazado        response_code 51 (fondos insuficientes). Igual llega con response "S"
 *   --codigo=12        código de rechazo puntual
 *   --sin-auth         code 00 pero sin authorization_number → NO debe crear orden
 *   --firma-mala       token inválido → no debe procesarse; debe quedar registrado
 *   --tipo=debit       payment_card_type (default credit)
 *   --url=http://…     destino (default http://localhost:3000/api/webhooks/bancard)
 *   --forzar-remoto    necesario si la URL no es localhost
 *
 * La clave privada se lee de BANCARD_PRIVATE_KEY (entorno) o de .env.local / .env en la carpeta
 * actual. Nunca se imprime.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const valor = (n, def) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? def;
const [shopProcessId, montoRaw] = args.filter((a) => !a.startsWith("--"));

if (!shopProcessId || !montoRaw) {
  console.error("Uso: simular-webhook.mjs <shop_process_id> <monto_pyg> [--rechazado|--sin-auth|--firma-mala|…]");
  process.exit(2);
}
const monto = Number(montoRaw);
if (!Number.isFinite(monto) || monto <= 0) {
  console.error(`Monto inválido: ${montoRaw}`);
  process.exit(2);
}

const url = valor("url", "http://localhost:3000/api/webhooks/bancard");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) && !flag("forzar-remoto")) {
  console.error(
    `\n${url} no es localhost. Un webhook con firma válida materializa una orden REAL (stock, mail, ERP).\n` +
      "Nunca contra producción. Si es un staging tuyo, agregá --forzar-remoto.\n"
  );
  process.exit(2);
}

function leerClave() {
  if (process.env.BANCARD_PRIVATE_KEY) return process.env.BANCARD_PRIVATE_KEY;
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^\s*BANCARD_PRIVATE_KEY\s*=\s*["']?([^"'\r\n]+)/m);
    if (m) return m[1].trim();
  }
  return null;
}
const PRIVATE_KEY = leerClave();
if (!PRIVATE_KEY) {
  console.error("Falta BANCARD_PRIVATE_KEY (entorno, .env.local o .env en la carpeta actual).");
  process.exit(2);
}

const md5 = (s) => createHash("md5").update(s).digest("hex");
const amount = monto.toFixed(2);
const currency = "PYG";
const codigo = valor("codigo", flag("rechazado") ? "51" : "00");
const aprobado = codigo === "00" && !flag("sin-auth");

const body = {
  operation: {
    token: flag("firma-mala") ? md5(`firma-invalida-${shopProcessId}`) : md5(`${PRIVATE_KEY}${shopProcessId}confirm${amount}${currency}`),
    shop_process_id: shopProcessId,
    response: "S", // Bancard manda "S" también cuando rechaza: por eso no alcanza
    response_code: codigo,
    response_description: aprobado ? "Transaccion aprobada." : "Transaccion denegada",
    response_details: "simulado",
    authorization_number: aprobado ? "123456" : null,
    ticket_number: "123456789123456",
    amount,
    currency,
    extra_attributes: { payment_card_type: valor("tipo", "credit") },
    security_information: { customer_ip: "127.0.0.1", card_source: "L", risk_index: "0" },
  },
};

const esperado = flag("firma-mala")
  ? "registrado como firma inválida, SIN orden"
  : aprobado
    ? "orden materializada (una sola vez aunque lo repitas)"
    : "intent marcado failed, SIN orden";
console.log(`\n→ POST ${url}\n  shop_process_id ${shopProcessId} · ${amount} ${currency} · code ${codigo}\n  esperado: ${esperado}\n`);

let res;
try {
  res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
} catch (e) {
  console.error(`No se pudo conectar a ${url} — ¿está corriendo el servidor? (${e.cause?.code ?? e.message})`);
  process.exit(1);
}
const texto = await res.text();
console.log(`← HTTP ${res.status} ${texto}`);
if (res.status !== 200 || !texto.includes("success")) {
  console.log('\n✗ El webhook SIEMPRE tiene que responder 200 {"status":"success"}, también al rechazar o con firma mala.');
  process.exit(1);
}
console.log("\nRevisá en la base: estado del intent, orden por payment_reference, stock y efectos.\n");
