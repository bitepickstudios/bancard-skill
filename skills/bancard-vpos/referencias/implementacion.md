# Implementación de referencia (intent-first)

Postgres + TypeScript. Los ejemplos de rutas son de Next.js App Router, pero cada pieza es
portable: lo importante es **dónde** vive cada decisión, no el framework. `db` es tu cliente
de base (pg, Prisma `$queryRaw`, Supabase `.rpc()`, etc.). El cliente de Bancard es
[../plantillas/bancard.ts](../plantillas/bancard.ts).

## 1. Esquema

```sql
-- Snapshot del checkout ANTES de pagar. La orden todavía no existe.
create table payment_intents (
  id              uuid primary key default gen_random_uuid(),
  shop_process_id bigint generated always as identity (start with 100000) unique,
  status          text not null default 'pending'
                  check (status in ('pending', 'consumed', 'failed', 'expired')),
  amount          numeric(15,2) not null,          -- exactamente lo que viaja a Bancard
  cart_snapshot   jsonb not null,                  -- [{variant_id, quantity, price, name}, …]
  customer        jsonb not null,                  -- nombre, email, teléfono, dirección…
  user_id         uuid,
  expires_at      timestamptz not null default now() + interval '15 minutes',  -- después, el cron consulta
  consumed_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on payment_intents (status, expires_at);

-- La llave Bancard ↔ orden. El UNIQUE es la última barrera contra pedidos duplicados.
alter table orders add column payment_reference bigint unique;
alter table orders add column needs_review boolean not null default false;

-- Webhooks con firma inválida: no se procesan, pero tampoco se pierden.
create table bancard_webhook_failures (
  id              bigint generated always as identity primary key,
  shop_process_id text,
  payload         jsonb,
  received_at     timestamptz not null default now(),
  resolved        boolean not null default false
);
```

- `payment_intents` es el espejo de la futura `orders`: **toda** columna que la orden necesite
  tiene que estar en el intent (o en sus jsonb). Si agregás una columna a `orders` y te olvidás
  del intent, el checkout con tarjeta se rompe antes de cobrar.
- La identidad garantiza `shop_process_id` único. Si reseteás la base de sandbox, arrancá la
  secuencia por encima de los ids ya usados: Bancard los recuerda.

## 2. Materializar: `confirm_payment()`

Una sola transacción: reclamar el intent, crear la orden, los ítems y descontar stock. La
llaman el webhook, el cron y cualquier "reintentar", **sólo** después de ver `isApproved()`.

```sql
create or replace function confirm_payment(p_shop_process_id bigint)
returns uuid language plpgsql as $$
declare
  v_intent   payment_intents%rowtype;
  v_order_id uuid;
  v_item     jsonb;
begin
  -- Reclamo atómico. El UPDATE bloquea la fila: un segundo llamador concurrente espera y,
  -- cuando entra, ya está 'consumed' → no encuentra nada. failed/expired también se reclaman:
  -- si Bancard aprobó, la plata ya salió y la orden tiene que existir.
  update payment_intents set status = 'consumed', consumed_at = now()
   where shop_process_id = p_shop_process_id and status <> 'consumed'
  returning * into v_intent;
  if not found then return null; end if;          -- ya materializado por otro camino

  insert into orders (payment_reference, user_id, customer, total, status)
  values (p_shop_process_id, v_intent.user_id, v_intent.customer, v_intent.amount, 'paid')
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(v_intent.cart_snapshot) loop
    insert into order_items (order_id, variant_id, quantity, unit_price, name)
    values (v_order_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::int,
            (v_item->>'price')::numeric, v_item->>'name');

    -- Descuento atómico. Si no alcanza, el cobro YA ocurrió: la orden se crea igual y se marca.
    update product_variants set stock = stock - (v_item->>'quantity')::int
     where id = (v_item->>'variant_id')::uuid and stock >= (v_item->>'quantity')::int;
    if not found then
      update orders set needs_review = true where id = v_order_id;
    end if;
  end loop;

  return v_order_id;                              -- null = no hice nada (ya estaba hecho)
end $$;
```

Adaptá columnas y tablas a tu esquema; lo que no se negocia es: reclamo atómico, todo en una
transacción, y que la falta de stock **no** aborte una orden ya cobrada.

Efectos posteriores (mail, ERP, logística) van **después** del commit, sólo si
`confirm_payment` devolvió un id (es decir, si esta llamada fue la que creó la orden), y
**fuera** del camino del webhook, que tiene 30 s. Cada efecto marca su hecho
(`orders.email_sent_at`, `orders.erp_sent_at`) y tiene su propio guard en el servidor (p. ej.
409 si `erp_sent_at` ya tiene valor): deshabilitar un botón no es protección. Un job que tome
órdenes pagadas con esas columnas en null reintenta lo que haya fallado.

```ts
import { after } from "next/server"; // fuera de Next.js: una cola o un job

async function settle(shopProcessId: string | number) {
  const [{ confirm_payment: orderId }] = await db.query("select confirm_payment($1)", [shopProcessId]);
  if (orderId) {
    after(() => afterPayment(orderId)); // mail, ERP, etc. — idempotentes por orden
    return;
  }
  // null = ya materializado… o no existe el intent. Lo segundo es un cliente cobrado sin pedido.
  const [intent] = await db.query("select 1 from payment_intents where shop_process_id = $1", [shopProcessId]);
  if (!intent) console.error("[bancard] ALERTA: cobro aprobado sin payment_intent", shopProcessId); // → canal de alertas
}
```

## 3. Iniciar el pago

```ts
// POST /api/checkout  (Route Handler)
import { singleBuy } from "@/lib/bancard";

export async function POST(req: Request) {
  const checkout = await validateCheckout(await req.json()); // precios y stock desde TU base, nunca del cliente
  const [intent] = await db.query(
    `insert into payment_intents (amount, cart_snapshot, customer, user_id)
     values ($1, $2, $3, $4) returning id, shop_process_id`,
    [checkout.total, JSON.stringify(checkout.items), JSON.stringify(checkout.customer), checkout.userId]
  );
  // En URLs públicas, el uuid del intent: el shop_process_id es secuencial y se puede adivinar.
  const back = `${process.env.SITE_URL}/checkout/confirmacion?intent=${intent.id}`;
  try {
    const { processId } = await singleBuy({
      shopProcessId: intent.shop_process_id,
      amount: checkout.total,                     // guaraníes enteros: 150000 → "150000.00" adentro
      description: `Pedido ${intent.shop_process_id}`.slice(0, 20),
      returnUrl: back,
    });
    return Response.json({ processId, intentId: intent.id });
  } catch (e) {
    // single_buy falló (red, credenciales, validación): este intent no se reusa.
    await db.query("update payment_intents set status = 'failed' where id = $1", [intent.id]);
    console.error("[bancard single_buy]", intent.shop_process_id, e);
    return Response.json({ error: "No se pudo iniciar el pago" }, { status: 502 });
  }
}
```

Cada intento de pago es un intent nuevo con su `shop_process_id` nuevo: también el "volver a
intentar" después de un rechazo o de un `single_buy` fallido. Nunca reenviar `single_buy` con un
`shop_process_id` ya usado.

## 4. Webhook

```ts
// POST /api/webhooks/bancard — URL cargada en el portal de comercios (perfil de la aplicación)
import { isApproved, verifyConfirmation, type BancardOperation } from "@/lib/bancard";

const ok = () => Response.json({ status: "success" }); // SIEMPRE 200, pase lo que pase

export async function POST(req: Request) {
  let op: BancardOperation | undefined;
  try {
    op = (await req.json())?.operation;
  } catch {
    console.warn("[bancard webhook] body no JSON");
    return ok();
  }
  try {
    if (!verifyConfirmation(op)) {
      await db.query("insert into bancard_webhook_failures (shop_process_id, payload) values ($1, $2)", [
        String(op?.shop_process_id ?? ""),
        JSON.stringify(op ?? null),
      ]);
      return ok();
    }
    if (isApproved(op)) {
      await settle(op!.shop_process_id!);
    } else {
      await db.query("update payment_intents set status = 'failed' where shop_process_id = $1 and status = 'pending'", [
        op!.shop_process_id,
      ]);
    }
  } catch (e) {
    // Error interno: igual 200. El intent sigue pending y el cron lo resuelve con getConfirmation().
    console.error("[bancard webhook]", op?.shop_process_id, e);
  }
  return ok();
}
```

- Bancard espera la respuesta en **30 segundos**: por eso `settle()` deja mail y ERP en
  `after()` (o en una cola) y el webhook responde apenas commitea la orden.
- Logueá `shop_process_id`, `response_code` y si la firma validó. Nunca el body crudo de
  tarjetas (no deberías recibirlo) ni la private key.

## 5. Reconciliación (red de seguridad)

La documentación de Bancard recomienda consultar el estado si no llegó confirmación en ~10
minutos. Sin este cron, un webhook perdido (deploy, caída, firma mal configurada) es un
cliente cobrado sin pedido.

```ts
// GET /api/cron/reconcile-bancard — cada 5–10 min
import { confirmationOp, getConfirmation, isApproved } from "@/lib/bancard";

const DEFINITIVO = new Set(["PaymentNotFoundError", "BuyNotFoundError"]);

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 }); // falla cerrado si falta el secreto
  }
  const intents = await db.query(
    `select shop_process_id from payment_intents
      where status = 'pending' and expires_at < now() order by created_at limit 50`
  );
  const res = { materialized: 0, expired: 0, retry: 0 };
  for (const { shop_process_id } of intents) {
    try {
      const r = await getConfirmation(shop_process_id);
      if (isApproved(confirmationOp(r))) {
        await settle(shop_process_id);
        res.materialized++;
      } else if (r.status === "success" || r.messages?.some((m) => DEFINITIVO.has(m.key))) {
        // Bancard respondió y no hay cobro aprobado → vencer.
        await db.query("update payment_intents set status = 'expired' where shop_process_id = $1 and status = 'pending'", [
          shop_process_id,
        ]);
        res.expired++;
      } else {
        res.retry++; // respuesta rara (InvalidTokenError, etc.): queda pending, alertar si se repite
      }
    } catch (e) {
      res.retry++; // error de red: NO vencer. Que falle tu llamada no dice nada del pago
      console.error("[bancard reconcile]", shop_process_id, e);
    }
  }
  return Response.json(res);
}
```

Un intent `expired` puede igual materializarse después: si llega un webhook aprobado tardío,
`confirm_payment` lo reclama. Por eso vencer es seguro.

Rollback de abandonadas: Bancard pide enviar `single_buy/rollback` también para compras
abandonadas. Si lo hacés desde este cron (después de que `getConfirmation` dijo "no pagó"),
mirá la clave de la respuesta: `PaymentNotFoundError` confirma que no había pago, pero
`RollbackSuccessful` significa que **sí** había uno (el cliente pagó entre la consulta y el
rollback) y acabás de anularlo: marcá la orden, si llegó a crearse, para revisión.

Verificá que tu hosting permita esa frecuencia (en algunos planes gratuitos, como Vercel Hobby,
los cron sólo corren una vez por día): si no, usá un scheduler externo contra la misma ruta.

## 6. Iframe de pago (React)

```tsx
"use client";
import { useEffect, useState } from "react";

const SCRIPT =
  process.env.NEXT_PUBLIC_BANCARD_ENV === "production"
    ? "https://vpos.infonet.com.py/checkout/javascript/dist/bancard-checkout-4.0.0.js"
    : "https://vpos.infonet.com.py:8888/checkout/javascript/dist/bancard-checkout-4.0.0.js";

declare global {
  interface Window {
    Bancard?: { Checkout: { createForm(id: string, processId: string, options: object): void } };
  }
}

export function BancardCheckout({ processId, confirmUrl }: { processId: string; confirmUrl: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // No depender de un onLoad: con next/script (y otros loaders con caché) el callback no se
    // vuelve a disparar en un segundo montaje y el formulario queda en blanco. Se espera a que
    // window.Bancard exista, venga de donde venga el script.
    if (!document.querySelector(`script[src="${SCRIPT}"]`)) {
      const s = document.createElement("script");
      s.src = SCRIPT;
      document.head.appendChild(s);
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.Bancard?.Checkout) {
        clearInterval(timer);
        window.Bancard.Checkout.createForm("bancard-form", processId, {
          styles: { "button-background-color": "#111111", "button-text-color": "#ffffff" },
          // Bancard avisa que terminó; el resultado REAL llega por webhook. Ir a la página que consulta.
          responseHandler: () => window.location.assign(confirmUrl),
        });
      } else if (Date.now() - started > 15_000) {
        clearInterval(timer);
        setFailed(true);
      }
    }, 200);
    return () => {
      clearInterval(timer);
      const el = document.getElementById("bancard-form");
      if (el) el.innerHTML = ""; // evita dos iframes con StrictMode / remontajes
    };
  }, [processId, confirmUrl]);

  if (failed) return <p>No se pudo cargar el formulario de pago. Recargá la página.</p>;
  return <div id="bancard-form" style={{ minWidth: 320, minHeight: 480 }} />;
}
```

- Ancho mínimo **320 px** (requisito de Bancard).
- Si tenés Content-Security-Policy, habilitá `https://vpos.infonet.com.py` y `:8888` en
  `script-src` y `frame-src`.
- `NEXT_PUBLIC_BANCARD_ENV` tiene que espejar a `BANCARD_ENV`: uno elige el iframe, el otro la API.
- Ante una respuesta desconocida del iframe, mostrala o logueala cruda; cerrar el diálogo "para
  que quede prolijo" borra la única evidencia del error.

## 7. Página de confirmación

- Bancard manda al cliente a `return_url` **también cuando la tarjeta fue rechazada**: esta
  página nunca asume éxito por el solo hecho de cargarse.
- Con el pago aprobado, mostrar fecha y hora, número de pedido (`shop_process_id`), importe y
  `response_description`. **Nunca** `authorization_number`, `response_code`,
  `extended_response_description` ni `security_information` (lo revisa la certificación).
- Consultar el estado del intent (endpoint propio, por el **uuid** del intent) cada ~3 s.
  `consumed` → mostrar el pedido. `failed` → "el pago fue rechazado" + volver a intentar, que
  arranca un checkout nuevo (intent y `shop_process_id` nuevos).
- Mostrar "Procesando tu pago" a pantalla completa desde el `responseHandler`: cada segundo
  sin feedback es un cliente que recarga o paga dos veces.
- A los ~45 s sin respuesta, ofrecer salida ("seguir esperando" / "volver a la tienda"). Antes
  no: el webhook puede estar viajando y se induce un doble pago.
- Todo endpoint del checkout tiene que funcionar con el intent: antes del webhook **no hay**
  número de orden.
