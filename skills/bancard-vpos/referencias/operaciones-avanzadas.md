# Operaciones avanzadas de vPOS

Lo que un ecommerce básico no necesita, pero existe en la API: pago con token en detalle,
preautorización, factura electrónica, Zimple, promociones, IVA de servicios digitales e índice
de riesgo. Cada uno suma ítems a la homologación: probalos en sandbox antes de activarlos.

Todas las operaciones usan los mismos hosts (`:8888` sandbox, sin puerto en producción) y la
misma forma `{ public_key, operation: { token, … } }` de [api.md](api.md).

## Pago con token (tarjetas guardadas)

Acepta crédito y débito, locales e internacionales.

### Catastro — `POST /cards/new`

Token: `md5(private_key + card_id + user_id + "request_new_card")`.

| Campo | Notas |
|---|---|
| `card_id` | Entero. Identificador de la tarjeta **en el comercio** (global, no por usuario). Uno nuevo por catastro |
| `user_id` | Entero. Tu id del usuario; el mismo en listar, cobrar y borrar |
| `user_cell_phone`, `user_mail` | Obligatorios |
| `return_url` | A donde vuelve el usuario (también si la tarjeta es rechazada) |

Devuelve `process_id` → `Bancard.Cards.createForm(contenedor, processId, opciones)` con el mismo
`bancard-checkout-4.0.0.js`. El formulario pide los datos de la tarjeta y la cédula en una sola
vista (en sandbox, cédula de prueba `9661000`). El `responseHandler` recibe
`add_new_card_success` o `add_new_card_fail`.

- Máximo **5 tarjetas** por `user_id`.
- Errores típicos en [codigos.md](codigos.md#3-errores-de-catastro-pago-con-token).

### Listar — `POST /users/{user_id}/cards`

Token: `md5(private_key + user_id + "request_user_cards")`. Opcional:
`extra_response_attributes: ["cards.bancard_proccesed"]` agrega `bancard_proccessed`
(`true` si la tarjeta la procesa Bancard; `false` = intra-país/internacional). Ojo: Bancard
escribe `proccesed`/`proccessed` así, con esa ortografía.

Cada tarjeta: `alias_token`, `card_masked_number`, `expiration_date`, `card_brand`, `card_id`,
`card_type` (`credit`/`debit`).

**El `alias_token` sirve para una sola operación y vence en minutos.** No lo guardes para
cobrar después: listá las tarjetas justo antes de cada `charge` y usá el token recién
obtenido. Un token viejo da `CardAliasTokenExpiredError`.

### Cobrar — `POST /charge`

Token: `md5(private_key + shop_process_id + "charge" + amount + currency + alias_token)`.

- `number_of_payments`: cuotas. Débito: siempre `1`. Crédito: el cliente puede elegir; la
  financia el emisor y el comercio recibe el total.
- `extra_response_attributes: ["confirmation.process_id"]`: **siempre**, para que funcione 3DS.
- La respuesta llega en el mismo request (segundos) **y** además llega el webhook.
  - Sin 3DS: `operation` completa → `isApproved(operation)`. Ojo: acá `amount` puede venir numérico.
  - Con 3DS: todo en `null` salvo `operation.process_id` →
    `Bancard.Charge3DS.createForm(contenedor, processId, opciones)`. Al terminar, el iframe
    avisa éxito y el resultado real llega por webhook.
- Comercios del rubro **casinos y juegos de azar** deben enviar el CVV en todas las
  transacciones (sujeto a multas).

### Borrar — `DELETE /users/{user_id}/cards`

Token: `md5(private_key + "delete_card" + user_id + alias_token)`, body con `alias_token`.

### Iframes en apps móviles

- **Android (WebView):** el iframe necesita cookies, incluidas las de terceros. Habilitar
  `CookieManager.setAcceptCookie(true)` y `setAcceptThirdPartyCookies(webView, true)`; si no,
  el formulario falla.
- **iOS app:** sin ese problema.
- **Safari / navegadores con "Prevent cross-site tracking":** pueden bloquear cookies del
  iframe. Si un cliente reporta que el formulario no avanza en Safari, es eso.

## Preautorización

Congela un monto y lo cobra después (reservas, pedidos con peso/cantidad variable).

1. `single_buy` o `charge` con `preauthorization: "S"`.
2. Confirmar con `POST /preauthorizations/confirm`.
   Token: `md5(private_key + shop_process_id + "pre-authorization-confirm")`.
   Opcional `amount` (y `billing.details`) para confirmar por otro monto.
3. Cancelar con `single_buy/rollback` (si no, vence sola a los **30 días** y se devuelve).

| | Tarjeta de crédito | Tarjeta de débito |
|---|---|---|
| Al preautorizar | Se congela en la cuenta del cliente; el comercio todavía no recibe nada | **Ya se debita** y se acredita al comercio |
| Confirmar por menos | Se libera la diferencia | Se devuelve la diferencia |
| Confirmar por más | Hasta **+20 %**, con un débito adicional por la diferencia | **No permitido** |
| Cancelar | Se descongela | Transferencia inversa al cliente |
| Boletas | Una sola | Distintas para preautorización y confirmación |
| Acreditación | No en línea (flujo de crédito) | En línea |

Reglas comunes:

- Monto mínimo a confirmar: el equivalente a **USD 1** (control de las marcas).
- Se confirma **una sola vez**. Si la confirmación sale rechazada, no se puede reintentar.
  Si falló la *comunicación* y no sabés si llegó, reenviá la confirmación.
- No entregues nada hasta tener la confirmación **aprobada** (mismo `isApproved()`).
- Si la confirmación falla, podés cancelar sin esperar los 30 días.

## Factura electrónica (`billing`)

Bancard puede emitir la factura electrónica junto con el pago si el comercio está habilitado.
Se agrega `billing` a `single_buy`, `charge` o a la confirmación de una preautorización:

```jsonc
"billing": {
  "client_ruc": "1234567-8",            // null o vacío = factura innominada
  "client_name": "Razón social",        // obligatorio si hay RUC
  "client_email": "cliente@correo.com", // obligatorio si hay RUC (máx 32 caracteres)
  "commerce_stamp": "12345678",         // timbrado vigente
  "commerce_establishment": "001",      // del timbrado
  "commerce_expedition_point": "001",   // del timbrado
  "details": [
    { "description": "Producto", "amount": "100000.00", "iva_rate": 10, "total_items": 1 }
  ]
}
```

- `details` no puede estar vacío y la suma de `amount × total_items` tiene que dar exactamente
  `operation.amount`. Ojo con descuentos y envío: van como ítems o prorrateados.
- `amount` del ítem es el precio **unitario**; `iva_rate` es la tasa como entero (`10`, `5`).
- Innominada (sin RUC): sólo hasta **Gs 7.000.000** (reglamentación de la DNIT).
- Datos de facturación inválidos → error y **el pago no se procesa**.
- Pago OK pero factura fallida → el pago queda procesado y el webhook trae el problema en
  `billing_response` (`status`, `description`); se puede regenerar desde el portal de
  facturación electrónica.
- Factura OK → `billing_response.data.invoice_number` (p. ej. `001-001-0002563`) en el webhook.
- En preautorización, la factura se genera al confirmar.

Operaciones opcionales:

| Operación | Endpoint | Token |
|---|---|---|
| Datos del cliente por RUC (nombre y email) | `POST /billing/client_info` con `client_ruc` | `md5(private_key + "billing_client_info")` |
| Cancelar factura emitida | `POST /billing/cancel` con `shop_process_id` | `md5(private_key + shop_process_id + "billing_cancel")` |

La cancelación sólo vale para comprobantes aprobados y hasta **24 h** después de emitidos.
Respuestas: `CancelInvoiceSuccessful` / `CancelInvoiceError`.

## IVA de servicios digitales (`iva_amount`)

Sólo para comercios alcanzados por la Ley de Servicios Digitales: `iva_amount` (decimal con dos
decimales) en `single_buy`/`charge`. El webhook devuelve `iva_amount` e `iva_ticket_number`.

## Zimple (billetera)

Mismo `single_buy`, con dos diferencias:

- `zimple: "S"`.
- `additional_data`: el celular del usuario con Zimple (`"0981123456"`).

Bancard le manda un código al teléfono; el iframe se monta con **otro** script,
`bancard-checkout-3.0.0.js`, y `Bancard.Zimple.createForm(contenedor, processId, opciones)`. El
usuario ingresa el código y se debita de la billetera. Confirmación por el mismo webhook.
Sandbox: teléfono `0981123456`, OTP `1234`.

## Promociones (`additional_data`)

Campo de hasta 255 caracteres para validar promociones acordadas entre comercio, Bancard y
emisor. Dos formatos **incompatibles entre sí** (elegir uno):

**Tradicional** (sólo crédito) — posiciones fijas, varias separadas por coma sin espacios:

| Posición | Dato | Formato | Ejemplo |
|---|---|---|---|
| 1–3 | Entidad | 3 dígitos, ceros a la izquierda | `099` |
| 4–6 | Marca | 3 caracteres, espacios a la derecha | `VS ` |
| 7–9 | Producto | 3 caracteres, espacios a la derecha | `ORO` |
| 10–15 | Afinidad | 6 dígitos, ceros a la izquierda | `000045` |

Se puede cortar después de cualquier bloque: `099` (entidad), `099VS` (entidad + marca),
`000VS` (sólo marca), `099VS ORO000045` (todo).

**Por BIN** (crédito y débito): `BIN` + hasta 10 dígitos, varios separados por coma:
`BIN54320034,BIN544198`. No aplica a tarjetas Infonet de BIN compartido ni a pagos QR con débito.

## Índice de riesgo (`security_information.risk_index`)

Viene en el webhook y en `confirmations`, junto con `card_source` (`L` local / `I`
internacional), `card_country` y `customer_ip`.

| Valor | Riesgo | Acción sugerida por Bancard |
|---|---|---|
| `0` | Sin dato | — |
| `1`–`3` | Bajo | Seguir normal |
| `4`–`6` | Medio | Pedir datos de verificación al cliente |
| `7`–`9` | Alto | Verificar con el cliente; sin respuesta, consultar a Bancard (riesgos@bancard.com.py) **antes** de entregar mercadería |

Sólo se calcula para **crédito local** procesado por Bancard: internacionales, débito y
crédito de otras procesadoras (Cabal, Panal) siempre dan `0`. Un `0` no significa "seguro".

## Personalización del iframe

Además de los `styles` del código, el portal (perfil de la aplicación) tiene temas
predefinidos, vista previa y opciones extra: colores de etiquetas, placeholder, errores, ícono
del CVV, pestaña de método de pago, radio de bordes (redondeado/píldora/recto), tamaño y fuente
del texto, posición de etiquetas (flotante/encima). Sandbox y producción tienen estilos
separados: hay que configurarlos en las dos pestañas. Ancho mínimo del formulario: 320 px.
