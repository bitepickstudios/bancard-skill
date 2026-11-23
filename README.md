# bancard-skill

Skill para agentes de código (Claude Code, Codex, Cursor y cualquier herramienta compatible
con [Agent Skills](https://agentskills.io)) que guía la integración del cobro con tarjeta de
**Bancard vPOS 2.0** (Paraguay): pago ocasional con iframe, webhook de confirmación,
reconciliación, rollback, pago con token / 3DS y homologación.

Sale de una integración real en producción y de los errores que costaron plata, empezando por
el más común: tratar `response: "S"` como "pago aprobado".

## Instalación

```bash
npx skills add bitepickstudios/bancard-skill
```

O a mano: copiá `skills/bancard-vpos/` a `.claude/skills/` de tu proyecto (o a
`~/.claude/skills/` para todos tus proyectos). En otros agentes, a la carpeta de skills que
use cada uno (`.agents/skills/`, etc.).

## Qué trae

| Archivo | Para qué |
|---|---|
| `SKILL.md` | Regla de aprobación, arquitectura intent-first, invariantes, firmas MD5, síntomas → causa, checklist de producción |
| `plantillas/bancard.ts` | Cliente sin dependencias (Node 18+): `singleBuy`, `verifyConfirmation`, `isApproved`, `getConfirmation`, `rollback`, tarjetas y `charge` |
| `referencias/implementacion.md` | Esquema SQL, `confirm_payment()` atómica, webhook, cron de reconciliación, iframe en React |
| `referencias/api.md` | Endpoints, payloads, códigos de respuesta y ambientes |
| `referencias/pruebas.md` | Datos de sandbox, checklist E2E, homologación, verificación post-deploy |
| `scripts/verificar-gate.mjs` | Busca en tu código gates de aprobación relajados (JS/TS, PHP, Python, …) |
| `scripts/simular-webhook.mjs` | Manda a tu localhost un webhook con firma válida: aprobado, rechazado, sin autorización o firma mala |

Uso directo de los scripts, sin agente:

```bash
node skills/bancard-vpos/scripts/verificar-gate.mjs ruta/a/tu/proyecto
node skills/bancard-vpos/scripts/simular-webhook.mjs <shop_process_id> <monto> --rechazado
```

## Aviso

No es un producto oficial de Bancard ni está afiliado a Bancard S.A. La fuente de verdad es la
documentación de vPOS que se descarga del portal de comercios; si algo de acá difiere, manda
esa.
