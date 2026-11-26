import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { summarizeCaseWithGemini } from "./llm/adapter.ts";
import {
  alertas,
  extraer,
  leerBuzon,
  registrar,
  validar,
  type ExtractedCase,
  type ToolContext,
} from "./tools/contratos.ts";

interface EvaluatedCase {
  messageId: string;
  extracted: ExtractedCase;
  decision: "nuevo" | "otrosi" | "duplicado" | "rechazado" | "confirmacion_humana";
  policyStatus: "pendiente" | "no_aplica" | "n/a";
  reasons: string[];
  aiSummary?: string;
}

const PORT = 3000;
const ROOT_DIR = process.cwd();

async function evaluateAllCases(): Promise<EvaluatedCase[]> {
  const ctx: ToolContext = { directory: ROOT_DIR };
  const buzonRes = await leerBuzon(ctx, { fixturePath: "fixtures/reto-02/buzon" });
  if (!buzonRes.ok || !buzonRes.data) {
    throw new Error(buzonRes.error ?? "No se pudo leer el buzón");
  }

  const results: EvaluatedCase[] = [];
  for (const msg of buzonRes.data.messages) {
    const extRes = await extraer(ctx, {
      messageId: msg.id,
      fixtureBase: "fixtures/reto-02",
    });
    if (!extRes.ok || !extRes.data) continue;

    const valRes = await validar(ctx, {
      messageId: msg.id,
      extracted: extRes.data,
      fixtureBase: "fixtures/reto-02",
      outDir: "out",
    });
    if (!valRes.ok || !valRes.data) continue;

    let aiSummary: string | undefined;
    if (valRes.data.decision === "confirmacion_humana") {
      const aiRes = await summarizeCaseWithGemini({
        directory: ROOT_DIR,
        messageId: msg.id,
        decision: valRes.data.decision,
        policyStatus: valRes.data.policyStatus,
        reasons: valRes.data.reasons,
        model: "gemini-3.5-flash-lite",
      });
      if (aiRes.ok && aiRes.text) {
        aiSummary = aiRes.text;
      }
    }

    results.push({
      messageId: msg.id,
      extracted: extRes.data,
      decision: valRes.data.decision,
      policyStatus: valRes.data.policyStatus,
      reasons: valRes.data.reasons,
      aiSummary,
    });
  }

  return results;
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (method === "GET" && url === "/") {
    try {
      const htmlPath = path.resolve(ROOT_DIR, "web/index.html");
      const html = await fs.readFile(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No se encontró web/index.html");
    }
    return;
  }

  if (method === "GET" && url === "/api/cases") {
    try {
      const cases = await evaluateAllCases();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, cases }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error evaluando casos";
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (method === "POST" && url === "/api/approve") {
    try {
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
      }
      const parsed = JSON.parse(body) as {
        messageId?: string;
        targetDecision?: "nuevo" | "rechazado";
      };

      const targetId = parsed.messageId ?? "msg-006";
      const targetDecision = parsed.targetDecision ?? "nuevo";
      const ctx: ToolContext = { directory: ROOT_DIR };

      const extRes = await extraer(ctx, {
        messageId: targetId,
        fixtureBase: "fixtures/reto-02",
      });
      if (!extRes.ok || !extRes.data) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: extRes.error ?? "No se pudo extraer el caso" }));
        return;
      }

      if (targetDecision === "rechazado") {
        await alertas(ctx, {
          messageId: targetId,
          status: "rechazado_por_humano",
          reason: "Rechazado tras revisión humana.",
          outDir: "out",
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, message: `${targetId} rechazado y anotado en alertas.` }));
        return;
      }

      const regRes = await registrar(ctx, {
        messageId: targetId,
        decision: "nuevo",
        approvedByHuman: true,
        extracted: extRes.data,
        outDir: "out",
      });

      if (!regRes.ok) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: regRes.error }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          message: `${targetId} registrado con aprobación humana en ${regRes.data?.persistedTo}.`,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error aprobando caso";
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Ruta no encontrada");
});

server.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});