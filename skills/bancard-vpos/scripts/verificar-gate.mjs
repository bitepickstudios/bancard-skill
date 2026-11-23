#!/usr/bin/env node
/**
 * Busca gates de aprobación de Bancard relajados en un código fuente, sin red ni base.
 *
 *   node verificar-gate.mjs [carpeta]        (default: carpeta actual)
 *   node verificar-gate.mjs --self-test
 *
 * Un "gate" es toda comparación de `response` con "S" (JS/TS, PHP, Python, Ruby, …). Para que
 * cuente como aprobación real, en esa línea o las 2 siguientes tiene que aparecer también
 * response_code "00" y authorization_number. Si no, es el bug que marca pagos rechazados
 * como aprobados: Bancard manda response "S" también cuando la tarjeta rebota.
 *
 * Sale con código 1 si encuentra un gate relajado.
 */
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url); // sus propios ejemplos no cuentan (la skill suele vivir dentro del proyecto)

const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".php", ".py", ".rb", ".go", ".java", ".cs", ".kt"]);
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "vendor", ".venv", "venv", "coverage", ".turbo", ".vercel"]);
// op.response === "S" | paymentResponse == 'S' | ['response'] == "S" | .response.equals("S")
const GATE = /[Rr]esponse\b['"\]]*\s*(?:===|==|\.equals\()\s*['"]S['"]/;
const CODE_00 = /['"]00['"]/;
const AUTH = /auth/i; // authorization_number, paymentAuth, auth_code…

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(name)) && st.size < 2_000_000 && resolve(p) !== SELF) yield p;
  }
}

export function scan(root) {
  const relajados = [];
  const correctos = [];
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!GATE.test(line)) return;
      const ventana = lines.slice(i, i + 3).join(" ");
      const where = `${file}:${i + 1}`;
      if (CODE_00.test(ventana) && AUTH.test(ventana)) correctos.push(where);
      else relajados.push({ where, falta: !CODE_00.test(ventana) ? 'response_code "00"' : "authorization_number", line: line.trim() });
    });
  }
  return { relajados, correctos };
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    writeFileSync(join(dir, "mal.ts"), 'const paid = bancardResponse === "S";\n');
    writeFileSync(join(dir, "medio.php"), "if ($op['response'] == 'S' && $op['response_code'] == '00') pagar();\n");
    writeFileSync(
      join(dir, "bien.ts"),
      'return op.response === "S" &&\n  op.response_code === "00" &&\n  !!op.authorization_number;\n'
    );
    const { relajados, correctos } = scan(dir);
    const nombres = relajados.map((r) => r.where.split(/[\\/]/).pop());
    const ok = relajados.length === 2 && correctos.length === 1 && nombres.some((n) => n.startsWith("mal.ts")) && nombres.some((n) => n.startsWith("medio.php"));
    console.log(ok ? "self-test ok" : `self-test FALLÓ: ${JSON.stringify({ relajados, correctos })}`);
    process.exit(ok ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--self-test") selfTest();

const root = process.argv[2] ?? ".";
const { relajados, correctos } = scan(root);

for (const c of correctos) console.log(`  ok     ${c}`);
for (const r of relajados) console.log(`  FALLA  ${r.where} — falta ${r.falta}\n         ${r.line}`);

if (correctos.length + relajados.length === 0) {
  console.log(`No se encontró ninguna comparación de response con "S" en ${root}.`);
  console.log("Si el gate vive en otra forma (switch, mapa, etc.), revisalo a mano: tiene que exigir S + 00 + authorization_number.");
} else if (correctos.length + relajados.length > 1) {
  console.log(`\n${correctos.length + relajados.length} sitios deciden la aprobación. Mejor uno solo (isApproved) reutilizado en todos.`);
}

if (relajados.length) {
  console.log(`\n${relajados.length} gate(s) relajado(s): aprueban pagos que el banco rechazó. No ir a producción así.`);
  process.exit(1);
}
