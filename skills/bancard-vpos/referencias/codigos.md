# Códigos de Bancard vPOS

Tres familias distintas, que no hay que mezclar:

1. **`response_code`** de la transacción (webhook, `confirmations`, `charge`): qué dijo el
   banco. Sólo `00` con `authorization_number` es un cobro.
2. **`messages[].key`** cuando la API responde `status: "error"`: qué le pasó a tu pedido.
3. **Errores de catastro** de tarjetas (pago con token).

## 1. `response_code` de la transacción

La documentación los lista sin ceros a la izquierda (`0`, `5`); en el JSON llegan como string
de dos caracteres (`"00"`, `"05"`). Hay códigos alfanuméricos (`5C`, `9G`).

Columna **Grupo**, para decidir qué ofrecerle al cliente (agrupación de esta guía, no de Bancard):

- **OK**: cobro aprobado.
- **T** temporal: problema del sistema o del emisor. Ofrecer reintentar en unos minutos.
- **C** cliente: datos, saldo, límites o tarjeta. Ofrecer corregir o usar otra tarjeta.
- **F** fraude/seguridad: no insistir. Mensaje genérico; no sugerir reintentos.
- **M** comercio: configuración del comercio con el procesador. Alertar al equipo, no es culpa del cliente.
- **X** otros: no son un cobro nuevo; leer la nota.

| Código | Significado | Grupo |
|---|---|---|
| `00` | Aprobada | OK |
| `01` | Llamar al centro de autorización | C |
| `02` | Consultar al emisor (condición especial) | C |
| `03` | Comercio inválido | M |
| `04` | Retener tarjeta | F |
| `05` | No aprobado | C |
| `06` | Error de sistema | T |
| `07` | Rechazo por control de seguridad | F |
| `08` | Transacción fallback rechazada | C |
| `09` | Solicitud en proceso — **no es estado final**: consultar con `confirmations` más tarde | T |
| `12` | Transacción inválida | C |
| `13` | Monto inválido | C |
| `14` | Tarjeta inexistente o inválida | C |
| `15` | Emisor inexistente o no habilitado para el comercio | M |
| `17` | Cancelado por el cliente | C |
| `19` | Intentar otra vez | T |
| `21` | Ninguna acción a tomar | X |
| `22` | Sospecha de mal funcionamiento | T |
| `30` | Error de formato del mensaje | T |
| `33` | Tarjeta vencida | C |
| `34` | Posible fraude, retener tarjeta | F |
| `35` | Llamar al procesador/adquirente | M |
| `36` | Tarjeta o cuenta bloqueada por la entidad | C |
| `37` | Mes de nacimiento incorrecto, tarjeta bloqueada | C |
| `38` | Tres claves equivocadas, tarjeta bloqueada | C |
| `39` | No existe cuenta de tarjeta de crédito | C |
| `40` | Tipo de transacción no soportado | C |
| `41` | Tarjeta perdida, retener | F |
| `42` | No aprobado, no existe cuenta universal | C |
| `43` | Tarjeta robada, retener | F |
| `45` | No existe la cuenta | C |
| `46` | El emisor no respondió a tiempo | T |
| `47` | El banco del comercio no respondió a tiempo | T |
| `49` | No acepta pago en cuotas | C |
| `5C` | Operación bloqueada por el emisor | C |
| `51` | Fondos insuficientes | C |
| `52` | No existe cuenta corriente | C |
| `53` | No existe caja de ahorro | C |
| `54` | Tarjeta vencida | C |
| `55` | Clave inválida | C |
| `57` | Transacción no permitida | C |
| `58` | No habilitada para esta terminal | M |
| `59` | No aprobado, posible fraude | F |
| `60` | Consultar al procesador/adquirente | M |
| `61` | Excede el monto límite | C |
| `62` | Tarjeta restringida | C |
| `63` | Violación de seguridad | F |
| `65` | Excede la cantidad de operaciones | C |
| `66` | Llamar a seguridad del procesador | F |
| `70` | Comercio en mora / factura pendiente | M |
| `71` | Operación ya extornada | X |
| `72` | Fecha inválida | C |
| `73` | Código de seguridad (CVV) inválido | C |
| `75` | Excede intentos de PIN | C |
| `77` | El cliente todavía no tiene clave | C |
| `78` | Cuenta inactiva (primer uso) | C |
| `79` | Clave cambiada | C |
| `80` | Clave activada o cambiada | C |
| `81` | Error criptográfico en el PIN | T |
| `82` | Error de autenticación | C |
| `83` | Fraude/seguridad: respuesta de la marca | F |
| `85` | Aprobado **sin impacto financiero** — no es un cobro | X |
| `86` | No se pudo verificar el PIN | T |
| `87` | Terminó la conciliación del día | T |
| `88` | Error criptográfico | T |
| `89` | Posición financiera no verificable | T |
| `9G` | Tarjeta bloqueada, contactar al emisor | C |
| `90` | Switch en cierre, reintentar en 5 minutos | T |
| `91` | Emisor en cierre, reintentar | T |
| `92` | Emisor desconectado | T |
| `93` | No aprobado, violación de ley | F |
| `94` | Transacción duplicada, no aprobada | X |
| `96` | Emisor fuera de servicio | T |
| `98` | Banco del comercio fuera de servicio | T |
| `99` | Transacción extornada (revertida) | X |

En producción pueden aparecer códigos fuera de esta tabla (p. ej. `N7`). Regla: todo lo que no
sea `00` con `authorization_number` es "no cobrado", y el texto que ve el cliente es
`response_description` (nunca el código: ver restricciones de la interfaz en
[pruebas.md](pruebas.md)).

Ojo con los reintentos: 7 rechazos de la misma tarjeta en 24 h (o 35 en 30 días) la bloquean
30 días en el comercio. Reintentar sólo ante errores **T** y siempre por acción del cliente,
nunca en un loop automático.

## 2. `messages[].key` de la API

Vienen con `status: "error"` (o `"success"` + `level: "info"` en las operaciones que lo
informan así).

| Clave | Significa | Qué hacer |
|---|---|---|
| `InvalidJsonError` | El JSON no se pudo leer | Revisar el body (y escapes `\uXXXX` de tildes) |
| `InvalidOperationError` | El JSON no cumple tipos o límites | Largo de `description` (20), formato de `amount`, `shop_process_id` entero |
| `InvalidTokenError` | Token MD5 mal armado | Orden de la concatenación, monto con `.00`, claves del ambiente correcto |
| `InvalidPublicKeyError` / `PublicKeyNotFoundError` | Clave pública mal o de otro ambiente | Claves de sandbox vs producción |
| `ApplicationNotFoundError` | Las credenciales no tienen aplicación | Revisar el perfil en el portal |
| `UnauthorizedOperationError` | Las credenciales no pueden hacer esa operación | Pedir habilitación a Bancard (p. ej. rollback, token) |
| `ApplicationCommunicationError`, `ApplicationCredentialNotFoundError`, `CantCreateApplicationCredentialError` | Problema de credenciales del lado de Bancard | Soporte de Bancard |
| `BuyNotFoundError` | No existe esa compra (`shop_process_id`) | En una consulta: nunca se inició o es de otro ambiente |
| `PaymentNotFoundError` | La compra existe pero **el cliente no pagó** | Respuesta válida: tratar como "no cobrado" |
| `InvalidAmountError` | Monto ≤ 0 | — |
| `AlreadyRollbackedError` | Ya tenía un rollback | Idempotente: tratar como anulado |
| `RollbackSuccessful` (info) | Rollback aceptado | — |
| `TransactionAlreadyConfirmed` | Rollback imposible: ya cuponada | Anulación manual por el portal (Soporte → Anulaciones) |
| `PosCommunicationError` | Falla de comunicación al pedir el rollback | Reintentar más tarde |
| `CancelInvoiceSuccessful` (info) / `CancelInvoiceError` | Resultado de cancelar una factura electrónica | Ver `dsc` |

## 3. Errores de catastro (pago con token)

| Clave | Significa |
|---|---|
| `CardAlreadyRegisteredByUserError` | Ese usuario ya tiene esa tarjeta catastrada |
| `InvalidCiError` | La cédula no coincide con la de la tarjeta |
| `CardRequestAlreadyProcessedError` | Ese `process_id` de catastro ya se usó: pedir otro `cards/new` |
| `NewCardRequestNotFoundError` | No existe el pedido de catastro de ese `process_id` |
| `CardInvalidDataError` | Datos de la tarjeta incorrectos |
| `CardNotFoundError` | La tarjeta no existe |
| `CardAliasTokenExpiredError` | El `alias_token` venció: volver a listar las tarjetas y usar el nuevo |
| `CardBlockedError` | La tarjeta está bloqueada para ese usuario |
| `InvalidCardStatus` | Estado de tarjeta incorrecto |

Mensajes del iframe de catastro (`responseHandler`): `add_new_card_success` o
`add_new_card_fail` (con `description` para mostrar al cliente).
