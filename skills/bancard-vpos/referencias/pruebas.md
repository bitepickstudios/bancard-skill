# Pruebas, homologación y pase a producción

## 0. Antes de nada

```bash
node scripts/verificar-gate.mjs <carpeta-del-proyecto>   # gates de aprobación relajados
```

Corre en segundos, sin red. Si tu proyecto no tiene suite de tests, este check más el
checklist E2E de abajo son toda tu red antes de tocar plata real.

## Datos de prueba del sandbox

| Dato | Valor |
|---|---|
| Teléfono para 3DS / Zimple | `0981123456` |
| OTP que aprueba | `1234` |
| Puerto del sandbox | `:8888` (tiene que estar habilitado en tu red/hosting) |

Las tarjetas de prueba las entrega Bancard en el portal de comercios. Para forzar un rechazo,
usá la tarjeta o el monto que el portal indique como denegado y verificá el `response_code` en
los logs del webhook.

`test_client: true` en el pedido evita que la operación cuente para la lista de test. Si estás
**haciendo** la homologación, no lo mandes.

## Checklist E2E (sandbox)

Ejecutalo entero antes de cualquier deploy que toque pagos.

| # | Caso | Cómo | Esperado |
|---|---|---|---|
| 1 | Aprobado | Checkout completo con tarjeta de prueba | Intent `consumed`, una orden con `payment_reference = shop_process_id`, stock descontado, mail enviado |
| 2 | Rechazado | Tarjeta/monto que devuelva `response_code` ≠ `00` | Intent `failed`, **cero** órdenes, stock intacto, sin mail |
| 3 | Aprobado "a medias" | `simular-webhook.mjs … --sin-auth` | Sin orden: falta `authorization_number` |
| 4 | Firma inválida | `simular-webhook.mjs … --firma-mala` | 200, fila en `bancard_webhook_failures`, sin orden |
| 5 | Webhook duplicado | Mandar el mismo aprobado dos veces | Una sola orden, un solo mail |
| 6 | Webhook y cron a la vez | Aprobado simulado + correr el cron en paralelo | Una sola orden |
| 7 | Webhook que no llega | Pagar en sandbox con el webhook apagado/inaccesible, esperar el cron | El cron consulta `confirmations` y materializa |
| 8 | Aprobado sobre intent vencido | Marcar el intent `expired` a mano y mandar aprobado | La orden se crea igual |
| 9 | Abandono | Abrir el iframe y cerrar la pestaña | Intent `pending` → `expired` por el cron; nunca una orden |
| 10 | Reintento sin recargar | Pagar, volver atrás, entrar de nuevo al checkout | El formulario se monta (no recuadro en blanco) |
| 11 | Confirmación colgada | Quedarse en la página de confirmación sin webhook | A los ~45 s aparece una salida; no se pide pagar de nuevo antes |
| 12 | Monto | Pedido con descuento + envío | El `amount` que viaja es exactamente el total, formato `"150000.00"` |
| 13 | Error interno en el webhook | Romper la base a propósito (p. ej. credencial mala) y mandar aprobado | Responde 200 igual; al restaurar, el cron materializa |

Si usás tarjetas guardadas, sumá: catastro, listado, cobro con `alias_token` sin 3DS, cobro con
3DS, borrado, y "La tarjeta ya ha sido catastrada" con un `card_id` nuevo por catastro.

## Simular el webhook

`scripts/simular-webhook.mjs` firma con tu `BANCARD_PRIVATE_KEY` y postea a tu servidor local.
Correlo desde la raíz del proyecto (lee `.env.local` o `.env` de ahí):

```bash
node scripts/simular-webhook.mjs <shop_process_id> <monto>                 # aprobado
node scripts/simular-webhook.mjs <shop_process_id> <monto> --rechazado     # code 51 con response "S"
node scripts/simular-webhook.mjs <shop_process_id> <monto> --sin-auth      # 00 sin authorization_number
node scripts/simular-webhook.mjs <shop_process_id> <monto> --firma-mala
node scripts/simular-webhook.mjs <shop_process_id> <monto> --url=http://localhost:8000/bancard/webhook
```

El `shop_process_id` y el monto salen del intent creado al arrancar un checkout con tarjeta:

```sql
select shop_process_id, amount, status from payment_intents order by created_at desc limit 5;
```

**Nunca contra producción**: un webhook con firma válida materializa una orden real, con stock,
mail y envío a sistemas externos. El script se niega a salir de localhost sin `--forzar-remoto`.

## Probar el cron

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reconcile-bancard
```

Sin el header tiene que dar 401, **también** si `CRON_SECRET` no está configurado.

## Reconciliar contra Bancard

Cuando la pregunta es "¿esto se cobró de verdad?", la respuesta la tiene Bancard:

- Un pedido: `getConfirmation(shop_process_id)` y evaluarlo con `isApproved()`. Cualquier
  herramienta de auditoría o botón de "reconciliar" del panel de admin usa **el mismo**
  `isApproved()`: una auditoría con el gate relajado esconde justo el error que tendría que
  encontrar.
- Un lote histórico: recorrer los pedidos de un rango, consultar uno por uno (con pausa entre
  llamadas) y clasificar: pagado en Bancard y no en tu base (crítico: cliente cobrado), pagado
  en tu base y no en Bancard (crítico: mercadería sin cobro), coincidentes.
- Antes de corregir en masa: snapshot de las filas afectadas en una tabla aparte y `BEGIN;`
  explícito. Nunca crear órdenes a mano: materializar por el mismo camino que el webhook.

## Homologación

Bancard exige completar la **lista de test** del portal de comercios en sandbox antes de
habilitar producción:

1. Cada ítem se marca en verde al ejecutarse con éxito: pago ocasional, confirmación al
   comercio (webhook respondido con 200), pedido de confirmación (`single_buy/confirmations`),
   rollback de una transacción aprobada, y los de pago con token si los usás.
2. Con todo en verde, "Solicitar certificación": se carga la URL a certificar (y usuario/clave
   si hace falta).
3. Soporte de Bancard hace compras de prueba contra esa URL.
4. Si está OK habilitan producción con las claves definitivas.
5. Cambiar a producción **juntos**: claves, URL de la API y `checkout.js` del iframe
   (`BANCARD_ENV` y `NEXT_PUBLIC_BANCARD_ENV` en la plantilla). Cargar la URL del webhook en el
   perfil de producción del portal.

Logo y nombre del comercio que ve el cliente se cargan en el portal, no en código.

## Después del deploy a producción

1. Un pago real chico, propio, con tarjeta real. Anularlo con rollback el mismo día si querés.
2. Los logs del webhook muestran la firma válida.
3. `select * from bancard_webhook_failures where not resolved;` vacío.
4. `select count(*) from payment_intents where status = 'pending' and expires_at < now() - interval '1 hour';`
   en cero (si no, el cron no está corriendo o no llega a Bancard).
5. Auditoría del día contra `getConfirmation()` sin diferencias.

Si aparece un cliente cobrado sin pedido: no crear la orden a mano. Consultar a Bancard y
materializar con `confirm_payment()`, igual que el webhook.
