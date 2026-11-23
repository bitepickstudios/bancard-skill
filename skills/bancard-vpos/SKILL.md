---
name: bancard-vpos
description: Usar cuando se integra, depura, audita o se lleva a producción el cobro con tarjeta de Bancard vPOS 2.0 (Paraguay, guaraníes) — single_buy, iframe checkout.js, webhook de confirmación (single_buy_confirm), firma MD5, single_buy/confirmations, rollback, pago con token (cards/new, alias_token, charge, 3DS), preautorización, factura electrónica (billing), Zimple, códigos de respuesta (response_code), homologación o lista de test del portal de comercios — y ante síntomas como pedidos marcados pagados con la tarjeta rechazada, cliente cobrado sin pedido, webhook con firma inválida, formulario de tarjeta en blanco, monto cobrado 100 veces menor o "La tarjeta ya ha sido catastrada". Card payment gateway integration, payment webhook, Paraguay.
---

# Bancard vPOS 2.0

Guía para integrar el cobro con tarjeta de Bancard (API `vpos/api/0.3`) sin perder plata ni
pedidos. Es agnóstica del stack; los ejemplos están en TypeScript/Node y SQL de Postgres.

**Principio:** la plata sale (o no sale) de la tarjeta antes de que tu código opine. Todo el
diseño existe para que tu base coincida con lo que pasó en Bancard — nunca al revés. Ante
cualquier duda, la verdad se le pregunta a Bancard (`single_buy/confirmations`), no a tu DB.

**Documentación:** las referencias de esta skill cubren la especificación vPOS 2.0 (Single
Buy v1.23) completa: operaciones, tokens, campos, códigos, preautorización, factura
electrónica, Zimple, homologación. La documentación oficial la entrega Bancard en el portal de
comercios (comercios.bancard.com.py); si el proyecto tiene una copia (buscá `bancard*.pdf` /
`*.txt`, p. ej. en `docs/bancard/`), leela para lo que acá no esté. Ante una diferencia, manda
la oficial más nueva.

## Regla de oro: qué es "aprobado"

```ts
const approved = op.response === "S" && op.response_code === "00" && !!op.authorization_number;
```

`response: "S"` **no** significa aprobado: significa que la API procesó el pedido. Las
transacciones rechazadas (`response_code` 05, 12, 15, 51, N7, …) llegan **también** con
`response: "S"` y `authorization_number` vacío. En una integración real en producción, un gate
que sólo miraba `response === "S"` marcó como pagadas decenas de compras rechazadas: stock
descontado, mails enviados y pedidos despachados sin cobro.

- Escribí el gate **una vez** (`isApproved()` en [plantillas/bancard.ts](plantillas/bancard.ts)) y
  usalo en todos los sitios que deciden: webhook, cron de reconciliación, cobro con token, 3DS,
  cualquier "reintentar/sincronizar" **y las herramientas de admin** (auditoría, botón
  "reconciliar", badges de "pagado"). Las copias inline son por donde se filtra el bug: es común
  arreglar el webhook y dejar la auditoría con el gate viejo, que entonces esconde justo el
  error que tendría que encontrar y "reconcilia" pagos rechazados como cobrados.
- `node scripts/verificar-gate.mjs <carpeta>` encuentra gates relajados en cualquier código.

## Arquitectura: el pedido nace cuando Bancard confirma

No crees la orden antes de cobrar. Una orden `pending_payment` creada al iniciar el pago deja
pedidos fantasma, mails y envíos a sistemas externos por pagos que nunca ocurrieron.

```
POST /checkout (tu API)
  ├─ INSERT payment_intents (snapshot del carrito, monto, cliente)  ← todavía NO hay orden
  ├─ singleBuy() → process_id
  └─ responde process_id
        ▼
Página de pago: iframe de Bancard (checkout.js → Bancard.Checkout.createForm)
        ▼  el cliente paga
POST /webhooks/bancard   (Bancard → tu servidor)
  ├─ firma inválida       → guardar en bancard_webhook_failures, responder 200, cortar
  ├─ !isApproved(op)      → intent = failed, responder 200
  └─ isApproved(op)       → confirm_payment(): reclamo atómico del intent + orden + ítems + stock
                            (una transacción) → después mail / ERP / envío
        ▼
Página de confirmación: consulta el estado del intent cada ~3 s

Cron cada 5–10 min: intents pending vencidos → getConfirmation() → materializar o vencer
```

Código completo (esquema SQL, función atómica, webhook, cron, iframe en React):
[referencias/implementacion.md](referencias/implementacion.md).

## Invariantes

| Invariante | Por qué |
|---|---|
| Aprobado = `S` + `00` + `authorization_number` | Regla de oro |
| Webhook: **siempre** HTTP 200 `{"status":"success"}`, en < 30 s | Si no, Bancard corta y marca la confirmación inválida en su traza. Tampoco implica que la compra se rechazó: hay que consultar |
| Firma inválida → no procesar, registrar, igual 200 | La firma MD5 es lo único que prueba que el POST vino de Bancard |
| Materializar con reclamo atómico + `UNIQUE(orders.payment_reference)` | Webhook, cron y reintentos llegan al mismo pago, a veces a la vez |
| Un intent `failed`/`expired` **no** frena un cobro aprobado | Tu cron pudo vencerlo mientras el cliente pagaba; la plata ya salió |
| Stock, mail, ERP, envío: **sólo** después de materializar | Cualquier otro punto los dispara sin cobro confirmado |
| `amount = total.toFixed(2)` → `"150000.00"` | PYG no tiene centavos pero la API exige dos decimales. **No dividir por 100** |
| `shop_process_id` entero ≤ 15 dígitos, único, nunca reutilizado | Es la llave de la compra en Bancard (confirmations, rollback). Usá una secuencia de la DB. Cada intento de pago (también un reintento tras un rechazo) es un intent nuevo |
| URLs públicas con el uuid del intent, no con `shop_process_id` | El `shop_process_id` es secuencial: en una URL de estado deja enumerar pedidos ajenos |
| `description` ≤ 20 caracteres | Límite de la API (String 20): recortar antes de mandar |
| Mismo ambiente en API y `checkout.js` | Iframe de sandbox contra API de producción (o al revés) = formulario que no funciona |
| Nunca tocar datos de tarjeta | El iframe es de Bancard (PCI); tu servidor sólo ve tokens |
| Error de red consultando a Bancard ≠ "no pagó" | No vencer un intent porque falló *tu* llamada |
| No reintentar cobros rechazados automáticamente | 7 rechazos de la misma tarjeta en 24 h la bloquean 30 días en el comercio |
| `return_url` no implica éxito | Bancard manda ahí al cliente también si la tarjeta fue rechazada |
| Pantalla de resultado sin `authorization_number`, `response_code` ni `security_information` | Lo prohíbe Bancard y lo revisa la certificación: mostrar fecha, pedido, importe y `response_description` |
| `alias_token` recién listado en cada `charge` | Es de un solo uso y vence en minutos |

## Firmas MD5 (resumen)

MD5 hex plano, concatenado sin separadores, **siempre empezando por la private key**. El orden
importa y un error no avisa: el pedido simplemente falla con `InvalidTokenError`.

| Operación | `md5(...)` |
|---|---|
| `single_buy` | `private_key + shop_process_id + amount + currency` |
| Webhook (validar) | `private_key + shop_process_id + "confirm" + amount + currency` |
| `single_buy/confirmations` | `private_key + shop_process_id + "get_confirmation"` |
| `single_buy/rollback` | `private_key + shop_process_id + "rollback" + "0.00"` |
| `cards/new` | `private_key + card_id + user_id + "request_new_card"` |
| `users/{id}/cards` | `private_key + user_id + "request_user_cards"` |
| `charge` | `private_key + shop_process_id + "charge" + amount + currency + alias_token` |
| Borrar tarjeta | `private_key + "delete_card" + user_id + alias_token` |

Preautorización (`"pre-authorization-confirm"`) y factura electrónica (`"billing_client_info"`,
`"billing_cancel"`) tienen los suyos. Tabla completa, endpoints, payloads y URLs por ambiente:
[referencias/api.md](referencias/api.md).

## Síntomas → causa probable

| Síntoma | Causa |
|---|---|
| Pedidos pagados que en Bancard están rechazados | Gate sólo con `response === "S"`. Auditar con `getConfirmation()` pedido por pedido |
| La auditoría dice que todo coincide, pero hay reclamos | La auditoría/reconciliación del admin tiene su propio gate relajado. `verificar-gate.mjs` lo encuentra |
| Cliente cobrado y sin pedido | Firma inválida descartada, webhook que falló sin cron de respaldo, o intent vencido que bloqueó la materialización |
| Pedido duplicado | Webhook + cron (o doble webhook) sin reclamo atómico ni `UNIQUE` |
| Bancard cobró 100× menos | Monto dividido por 100 |
| `InvalidTokenError` | Orden de concatenación, monto sin `.00`, o claves de otro ambiente |
| Firma del webhook nunca valida | Validás con un monto distinto al firmado (Bancard firma `"150000.00"`, con dos decimales), o `BANCARD_PRIVATE_KEY` de otro ambiente |
| Recuadro en blanco donde va la tarjeta | `createForm` atado a un `onLoad` que no se vuelve a disparar (p. ej. `next/script` en un segundo montaje). Esperar a `window.Bancard` con polling |
| "Verificando pago…" eterno | La página de confirmación no tiene salida. Ofrecerla a los ~45 s (no antes: induce doble pago) |
| "La tarjeta ya ha sido catastrada" | `card_id` reutilizado: es global del comercio, no por usuario |
| `CardAliasTokenExpiredError` | Cobrando con un `alias_token` guardado. Listar las tarjetas justo antes del `charge` |
| El formulario no avanza en una app Android o en Safari | El iframe necesita cookies de terceros: habilitarlas en el WebView; en Safari, "Prevent cross-site tracking" |
| `response_code` `09` | "Solicitud en proceso": no es un rechazo final. Consultar con `confirmations` más tarde |
| Qué mensaje mostrar ante un rechazo | Tabla de códigos agrupada por "reintentar / otra tarjeta / fraude / problema del comercio" en [referencias/codigos.md](referencias/codigos.md) |
| Tarjeta guardada que no aparece | Tabla local desincronizada: reconstruir con upsert desde `users/{id}/cards` |
| `payment_card_type` siempre null | Viene anidado en `operation.extra_attributes`, no en la raíz |
| Sandbox no responde | El sandbox usa el puerto **8888**: tiene que estar abierto en tu red/hosting |

## Antes de producción

1. `node scripts/verificar-gate.mjs .` sin hallazgos.
2. Checklist E2E en sandbox de [referencias/pruebas.md](referencias/pruebas.md): aprobado,
   rechazado, firma inválida, webhook duplicado, webhook que no llega, reintento del cliente.
   `node scripts/simular-webhook.mjs` prueba el webhook sin pagar.
3. Lista de test del portal de comercios en verde → solicitar certificación → claves de
   producción (detalle en pruebas.md).
4. Cambiar **juntos** la API y el `checkout.js` a producción, y la URL de confirmación en el
   portal (perfil de la aplicación).
5. Un pago real chico propio. Revisar: firma válida en logs, cero filas nuevas en
   `bancard_webhook_failures`, el pedido coincide con `getConfirmation()`.

## Archivos

- [plantillas/bancard.ts](plantillas/bancard.ts) — cliente listo para copiar: firmas, llamadas, `isApproved`, `verifyConfirmation`.
- [referencias/implementacion.md](referencias/implementacion.md) — esquema SQL, `confirm_payment()` atómica, webhook, cron, iframe.
- [referencias/api.md](referencias/api.md) — ambientes, formatos, todas las operaciones del pago simple y con token, todos los tokens.
- [referencias/codigos.md](referencias/codigos.md) — los `response_code` (agrupados por qué hacer), claves de error de la API y de catastro.
- [referencias/operaciones-avanzadas.md](referencias/operaciones-avanzadas.md) — pago con token en detalle, preautorización, factura electrónica, Zimple, promociones, IVA de servicios digitales, índice de riesgo, personalización.
- [referencias/pruebas.md](referencias/pruebas.md) — datos de sandbox, checklist E2E, lista de test, restricciones de certificación, post-deploy.
- `scripts/verificar-gate.mjs` — busca gates de aprobación relajados. `scripts/simular-webhook.mjs` — webhook firmado contra localhost.
