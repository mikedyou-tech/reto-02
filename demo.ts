import path from "node:path";
import { summarizeCaseWithGemini } from "./src/llm/adapter.ts";
import {
  alertas,
  extraer,
  leerBuzon,
  registrar,
  validar,
  type ToolContext,
} from "./src/tools/contratos.ts";

async function runDemo(): Promise<void> {
  const ctx: ToolContext = {
    directory: process.cwd(),
  };

  console.log("Carpeta base del proyecto:", ctx.directory);

  const buzonRes = await leerBuzon(ctx, {
    fixturePath: "fixtures/reto-02/buzon",
  });

  if (!buzonRes.ok || !buzonRes.data) {
    console.error("Error leyendo buzón:", buzonRes.error);
    return;
  }

  console.log(`Mensajes encontrados (${buzonRes.data.messages.length}):`);

  for (const msg of buzonRes.data.messages) {
    console.log(`\n--- Procesando ${msg.id} ---`);

    const extRes = await extraer(ctx, {
      messageId: msg.id,
      fixtureBase: "fixtures/reto-02",
    });

    if (!extRes.ok || !extRes.data) {
      console.error(`Error extrayendo ${msg.id}:`, extRes.error);
      continue;
    }

    const valRes = await validar(ctx, {
      messageId: msg.id,
      extracted: extRes.data,
      fixtureBase: "fixtures/reto-02",
      outDir: "out",
    });

    if (!valRes.ok || !valRes.data) {
      console.error(`Error validando ${msg.id}:`, valRes.error);
      continue;
    }

    const { decision, policyStatus, reasons } = valRes.data;
    console.log("Decisión:", decision, "| Póliza:", policyStatus);
    console.log("Motivos:", reasons.join(" "));

    if (decision === "confirmacion_humana") {
      await alertas(ctx, {
        messageId: msg.id,
        status: "pendiente_confirmacion_humana",
        reason: reasons.join(" "),
        outDir: "out",
      });
      console.log("Acción: Esperando confirmación humana (no registrado aún).");
      const aiRes = await summarizeCaseWithGemini({
      directory: ctx.directory,
      messageId: msg.id,
      decision,
      policyStatus,
      reasons,
      model: "gemini-3.5-flash-lite",
    });
    if (aiRes.ok && aiRes.text) {
      console.log("Resumen del agente (Gemini):", aiRes.text);
    } else if (aiRes.error) {
      console.log("Aviso LLM:", aiRes.error);
    }
    } else if (decision === "rechazado" || decision === "duplicado") {
      await alertas(ctx, {
        messageId: msg.id,
        status: decision,
        reason: reasons.join(" "),
        outDir: "out",
      });
      console.log(`Acción: Marcado como ${decision} y anotado en alertas.`);
    } else {
      const regRes = await registrar(ctx, {
        messageId: msg.id,
        decision,
        approvedByHuman: false,
        extracted: extRes.data,
        outDir: "out",
      });
      if (regRes.ok && regRes.data) {
        console.log(`Acción: Registrado en ${path.normalize(regRes.data.persistedTo)}.`);
      } else {
        console.error(`Error registrando ${msg.id}:`, regRes.error);
      }
    }
  }
}

runDemo();