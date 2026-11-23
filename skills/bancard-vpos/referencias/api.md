# API de Bancard vPOS 2.0 — hoja de referencia

Resumen operativo de la API `0.3`. La fuente oficial es la documentación de vPOS que se
descarga del portal de comercios (comercios.bancard.com.py); ante cualquier diferencia, manda
la versión que te entregue Bancard.

## Ambientes

| Recurso | Sandbox (staging) | Producción |
|---|---|---|
| API | `https://vpos.infonet.com.py:8888/vpos/api/0.3` | `https://vpos.infonet.com.py/vpos/api/0.3` |
| Checkout (redirect) | `https://vpos.infonet.com.py:8888/checkout/new?process_id=…` | `https://vpos.infonet.com.py/checkout/new?process_id=…` |
| `checkout.js` (iframe) | `https://vpos.infonet.com.py:8888/checkout/javascript/dist/bancard-checkout-4.0.0.js` | `https://vpos.infonet.com.py/checkout/javascript/dist/bancard-checkout-4.0.0.js` |

- El sandbox usa el puerto **8888**: tu hosting/red tiene que poder salir por ahí.
- Claves: pública `[a-zA-Z0-9]{32}`, privada de 40 caracteres. Cada ambiente tiene las suyas.
- La URL de confirmación (webhook) se configura en el portal, en el perfil de la aplicación;
  no viaja en los pedidos.
- Moneda: sólo `PYG`.

```env
BANCARD_PUBLIC_KEY=…
BANCARD_PRIVATE_KEY=…            # nunca sale del servidor
BANCARD_ENV=sandbox              # sandbox | production
NEXT_PUBLIC_BANCARD_ENV=sandbox  # espejo: elige el checkout.js del iframe
CRON_SECRET=…                    # protege el cron de reconciliación
```

## Formato de los datos

- `amount`: string decimal con punto y **dos** decimales: `150000` → `"150000.00"`. Se firma
  con el mismo string. No se divide por 100.
- `shop_process_id`: entero de hasta 15 dígitos; se manda numérico y se firma con los mismos
  dígitos. Global del comercio.
- `description`: string de hasta 20 caracteres.
- Todas las peticiones: `{ "public_key": "…", "operation": { "token": "md5…", … } }`.
- Errores: `{ "status": "error", "messages": [{ "key": "…", "level": "error", "dsc": "…" }] }`.
  Claves posibles: `InvalidJsonError`, `UnauthorizedOperationError`, `ApplicationNotFoundError`,
  `InvalidPublicKeyError`, `InvalidTokenError`, `InvalidOperationError`, `BuyNotFoundError`,
  `PaymentNotFoundError`, `AlreadyRollbackedError`, `PosCommunicationError`,
  `RollbackSuccessful`, `TransactionAlreadyConfirmed`.

## `POST /single_buy` — iniciar pago ocasional

```jsonc
{
  "public_key": "…",
  "operation": {
    "token": "md5(private_key + shop_process_id + amount + currency)",
    "shop_process_id": 100231,
    "amount": "150000.00",
    "currency": "PYG",
    "description": "Pedido 100231",
    "return_url": "https://tienda.com.py/checkout/confirmacion?intent=100231",
    "cancel_url": "https://tienda.com.py/checkout/confirmacion?intent=100231",
    "extra_response_attributes": ["payment_card_type"]
  }
}
```

Respuesta: `{ "status": "success", "process_id": "…" }`. Con el `process_id` se monta el iframe
(`Bancard.Checkout.createForm`) o se redirige a `checkout/new?process_id=…`.

Campos opcionales que existen y no son necesarios para un ecommerce básico: `iva_amount` (Ley
de Servicios Digitales), `additional_data` (promociones por BIN, `"BIN543200,BIN544198"`),
`preauthorization: "S"`, `billing` (factura electrónica), `zimple: "S"` (billetera Zimple).
Cada uno trae sus propias reglas y su ronda de homologación.

`test_client: true` en el pedido hace que la operación **no** cuente para la lista de test del
portal. Si estás haciendo la homologación, no lo mandes.

## Confirmación (webhook entrante)

Bancard postea a tu URL al terminar cada transacción, aprobada o no:

```jsonc
{
  "operation": {
    "token": "md5(private_key + shop_process_id + 'confirm' + amount + currency)",
    "shop_process_id": "100231",
    "response": "S",                         // sólo: "la API procesó"
    "response_code": "00",                   // ESTE dice si se aprobó
    "response_description": "Transacción aprobada.",
    "response_details": "…",
    "authorization_number": "123456",        // vacío si no se aprobó
    "ticket_number": "123456789123456",
    "amount": "150000.00",
    "currency": "PYG",
    "extra_attributes": { "payment_card_type": "credit" },
    "security_information": { "customer_ip": "…", "card_source": "L", "card_country": "…", "risk_index": "0" }
  }
}
```

- Responder `200` con `{ "status": "success" }` **dentro de 30 s**, siempre.
- Si no respondés 200, eso **no** significa que la compra quedó rechazada: hay que consultar.
- `card_source`: `L` local, `I` internacional. `risk_index`: sólo para crédito local.
- Es el único aviso que manda Bancard. Lo que no llegó o falló se recupera con
  `single_buy/confirmations`.

## Códigos de respuesta

| `response_code` | Significado |
|---|---|
| `00` | Aprobada — **el único aprobado** |
| `05` | Tarjeta inhabilitada |
| `12` | Transacción inválida |
| `15` | Tarjeta inválida |
| `51` | Fondos insuficientes |
| `99` | Transacción extornada |

La lista no es exhaustiva (en producción aparecen otros, p. ej. `N7`). Todo lo que no sea `00`
con `authorization_number` es rechazo.

## `POST /single_buy/confirmations` — consultar estado

```jsonc
{ "public_key": "…", "operation": { "token": "md5(private_key + shop_process_id + 'get_confirmation')", "shop_process_id": 100231 } }
```

Respuesta con la misma forma que el webhook, dentro de `confirmation` (leer también
`operation` por las dudas: `confirmationOp()` en la plantilla). Se evalúa con el mismo
`isApproved()`. Si no hubo cobro, la respuesta no trae una operación aprobada (puede venir
`status: "error"` con `messages`, p. ej. `BuyNotFoundError`/`PaymentNotFoundError`). Logueá la
respuesta cruda las primeras veces para confirmar qué devuelve tu ambiente.

## `POST /single_buy/rollback` — anular

Token: `md5(private_key + shop_process_id + "rollback" + "0.00")` — el monto firmado es
siempre `"0.00"`.

- Sólo el mismo día y mientras la transacción **no esté cuponada** (impactada en el extracto).
- `TransactionAlreadyConfirmed` → ya cuponada: anulación manual por el portal de comercios
  (Soporte → Anulaciones).
- Otras claves: `RollbackSuccessful`, `AlreadyRollbackedError`.

## Pago con token (tarjetas guardadas)

| Paso | Endpoint | Notas |
|---|---|---|
| Catastrar | `POST /cards/new` con `card_id`, `user_id`, `user_cell_phone`, `user_mail`, `return_url` | Devuelve `process_id` → `Bancard.Cards.createForm(container, processId, options)` |
| Listar | `POST /users/{user_id}/cards` | Devuelve `cards[]` con `alias_token`, `card_masked_number`, `card_brand`, `expiration_date`, `card_id` |
| Cobrar | `POST /charge` con `alias_token`, `number_of_payments` | Ver abajo |
| Borrar | `DELETE /users/{user_id}/cards` con `alias_token` | |

- `card_id` es **global del comercio**, no por usuario. Un rango chico por usuario se agota y
  Bancard responde "La tarjeta ya ha sido catastrada".
- Máximo 5 tarjetas por `user_id`.
- Bancard es la fuente de verdad de las tarjetas: la tabla local se reconstruye con upsert
  desde el listado.

`charge` responde por HTTP y además manda el webhook:

- **Sin 3DS:** `operation` completa → `isApproved(operation)`.
- **Con 3DS:** todos los campos en `null` salvo `operation.process_id` (pedirlo con
  `extra_response_attributes: ["confirmation.process_id"]`). Montar
  `Bancard.Charge3DS.createForm(container, processId, options)` y esperar el webhook.

Bloqueo por rechazos: 7 rechazos de la misma tarjeta en 24 h (o 35 en 30 días) la inhabilitan
30 días en el comercio. No reintentes cobros automáticamente.

## Iframe

```js
Bancard.Checkout.createForm("contenedor", processId, { styles: { … }, responseHandler: (data) => { … } });
```

- Ancho mínimo 320 px.
- Los estilos también se configuran en el portal; los del código los pisan. Claves:
  `form-background-color`, `button-background-color`, `button-text-color`,
  `button-border-color`, `input-background-color`, `input-text-color`,
  `input-placeholder-color`, `input-border-color`, `header-background-color`,
  `header-text-color`.
- El `responseHandler` sólo avisa que el iframe terminó. El resultado del pago llega por webhook.

## Lo que esta guía no cubre

Preautorización (`preauthorization/confirm`, ±20 % del monto, vence a 30 días), factura
electrónica (`billing`), Zimple y promociones por BIN existen en la API. Si los activás, leé
esa sección de la documentación oficial y sumalos a la homologación.
