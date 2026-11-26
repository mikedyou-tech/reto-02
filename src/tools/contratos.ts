import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface ToolContext {
  directory: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

const LeerBuzonInputSchema = z.object({
  fixturePath: z.string().min(1).default("fixtures/reto-02/buzon"),
});

const ExtraerInputSchema = z.object({
  messageId: z.string().min(1),
  fixtureBase: z.string().min(1).default("fixtures/reto-02"),
});

const ExtractedSchema = z.object({
  messageId: z.string(),
  subject: z.string(),
  sender: z.string(),
  docType: z.enum(["contrato", "otrosi", "cotizacion", "desconocido"]),
  contractNumber: z.string().nullable(),
  counterparty: z.string().nullable(),
  amount: z.number().nullable(),
  termMonths: z.number().nullable(),
  requiresPolicy: z.boolean().nullable(),
  needsHumanReview: z.boolean(),
  rawSummary: z.string(),
});

const ValidarInputSchema = z.object({
  messageId: z.string().min(1),
  extracted: ExtractedSchema,
  fixtureBase: z.string().min(1).default("fixtures/reto-02"),
  outDir: z.string().min(1).default("out"),
});

const RegistrarInputSchema = z.object({
  messageId: z.string().min(1),
  decision: z.enum([
    "nuevo",
    "otrosi",
    "duplicado",
    "rechazado",
    "confirmacion_humana",
  ]),
  approvedByHuman: z.boolean().default(false),
  extracted: ExtractedSchema,
  outDir: z.string().min(1).default("out"),
});

const AlertasInputSchema = z.object({
  messageId: z.string().min(1),
  status: z.string().min(1),
  reason: z.string().min(1),
  outDir: z.string().min(1).default("out"),
});

export type ExtractedCase = z.infer<typeof ExtractedSchema>;

function resolveSafePath(baseDir: string, relativeOrSubpath: string): string {
  const normalized = relativeOrSubpath.replaceAll("\\", "/");
  return path.resolve(baseDir, normalized);
}

async function readJsonSafe(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as unknown;
}

async function listTextFilesInDir(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      results.push(path.join(dirPath, entry.name));
    }
  }
  return results;
}

function parseNumberFromText(text: string): number | null {
  const match = text.match(
    /(?:\$|COP\s*|USD\s*)?([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]+)?)/i
  );
  if (!match || !match[1]) return null;
  const cleaned = match[1].replaceAll(".", "").replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseContractCode(text: string): string | null {
  const ctMatch = text.match(/\b(CT-\d{4}-\d+)\b/i);
  if (ctMatch && ctMatch[1]) return ctMatch[1].toUpperCase();
  const cotMatch = text.match(/\b(COT-\d{4}-\d+)\b/i);
  if (cotMatch && cotMatch[1]) return cotMatch[1].toUpperCase();
  return null;
}

export async function leerBuzon(
  ctx: ToolContext,
  rawInput: unknown
): Promise<ToolResult<{ messages: Array<{ id: string; folder: string; files: string[] }> }>> {
  try {
    const parsed = LeerBuzonInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { ok: false, error: `Entrada inválida en leer_buzon: ${parsed.error.message}` };
    }
    const buzonDir = resolveSafePath(ctx.directory, parsed.data.fixturePath);
    const entries = await fs.readdir(buzonDir, { withFileTypes: true });
    const messages: Array<{ id: string; folder: string; files: string[] }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const msgDir = path.join(buzonDir, entry.name);
        const childEntries = await fs.readdir(msgDir, { withFileTypes: true });
        const files = childEntries
          .filter((c: { isFile: () => boolean }) => c.isFile())
          .map((c: { name: string }) => c.name);
        messages.push({
          id: entry.name,
          folder: path.relative(ctx.directory, msgDir).replaceAll("\\", "/"),
          files,
        });
      }
    }

    messages.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, data: { messages } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido en leer_buzon";
    return { ok: false, error: message };
  }
}

export async function extraer(
  ctx: ToolContext,
  rawInput: unknown
): Promise<ToolResult<ExtractedCase>> {
  try {
    const parsed = ExtraerInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `Entrada inválida en extraer: ${parsed.error.message}` };
    }

    const msgDir = resolveSafePath(
      ctx.directory,
      `${parsed.data.fixtureBase}/buzon/${parsed.data.messageId}`
    );

    let subject = "";
    let sender = "";
    const correoPath = path.join(msgDir, "correo.json");
    try {
      const correoData = await readJsonSafe(correoPath);
      if (typeof correoData === "object" && correoData !== null) {
        const record = correoData as Record<string, unknown>;
        for (const key of ["asunto", "subject"]) {
          if (typeof record[key] === "string") subject = record[key] as string;
        }
        for (const key of ["de", "remitente", "from", "sender"]) {
          if (typeof record[key] === "string") sender = record[key] as string;
        }
      }
    } catch {
      // Si correo.json no existe o no tiene esos campos, seguimos con los .txt
    }

    const txtFiles = await listTextFilesInDir(msgDir);
    let combinedText = "";
    let primaryFileName = "";
    for (const filePath of txtFiles) {
      const content = await fs.readFile(filePath, "utf-8");
      combinedText += `\n${content}`;
      if (!primaryFileName) {
        primaryFileName = path.basename(filePath).toLowerCase();
      }
    }

    const fullText = `${subject}\n${combinedText}`.trim();
    const lowerText = fullText.toLowerCase();

    let docType: ExtractedCase["docType"] = "desconocido";
    if (
      primaryFileName.includes("cotizacion") ||
      lowerText.includes("cotización") ||
      lowerText.includes("cotizacion")
    ) {
      docType = "cotizacion";
    } else if (
      primaryFileName.includes("otrosi") ||
      lowerText.includes("otrosí") ||
      lowerText.includes("otrosi")
    ) {
      docType = "otrosi";
    } else if (
      primaryFileName.includes("contrato") ||
      lowerText.includes("contrato")
    ) {
      docType = "contrato";
    }

    const contractNumber = parseContractCode(fullText);
    const amount = parseNumberFromText(combinedText);

    let termMonths: number | null = null;
    const monthsMatch = combinedText.match(/(\d+)\s*mes(?:es)?/i);
    if (monthsMatch && monthsMatch[1]) {
      termMonths = Number(monthsMatch[1]);
    }

    let requiresPolicy: boolean | null = null;
    if (
      lowerText.includes("sin póliza") ||
      lowerText.includes("sin poliza") ||
      lowerText.includes("no requiere póliza") ||
      lowerText.includes("no requiere poliza") ||
      lowerText.includes("póliza: no") ||
      lowerText.includes("poliza: no") ||
      lowerText.includes("póliza: no aplica") ||
      lowerText.includes("poliza: no aplica")
    ) {
      requiresPolicy = false;
    } else if (lowerText.includes("póliza") || lowerText.includes("poliza")) {
      requiresPolicy = true;
    }

    const needsHumanReview =
      lowerText.includes("por confirmar") ||
      lowerText.includes("pendiente por confirmar") ||
      lowerText.includes("borrador") ||
      lowerText.includes("urgente") ||
      lowerText.includes("excepción") ||
      lowerText.includes("excepcion") ||
      lowerText.includes("revisión") ||
      lowerText.includes("revision") ||
      lowerText.includes("no verificado");

    let counterparty: string | null = null;
    const lines = combinedText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      counterparty = lines[0] ?? null;
    }

    const extracted: ExtractedCase = {
      messageId: parsed.data.messageId,
      subject,
      sender,
      docType,
      contractNumber,
      counterparty,
      amount,
      termMonths,
      requiresPolicy,
      needsHumanReview,
      rawSummary: fullText.slice(0, 240),
    };

    return { ok: true, data: extracted };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido en extraer";
    return { ok: false, error: message };
  }
}

export async function validar(
  ctx: ToolContext,
  rawInput: unknown
): Promise<
  ToolResult<{
    decision: "nuevo" | "otrosi" | "duplicado" | "rechazado" | "confirmacion_humana";
    policyStatus: "pendiente" | "no_aplica" | "n/a";
    reasons: string[];
  }>
> {
  try {
    const parsed = ValidarInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `Entrada inválida en validar: ${parsed.error.message}` };
    }

    const { messageId, extracted, fixtureBase, outDir } = parsed.data;
    const reasons: string[] = [];

    const maestroPath = resolveSafePath(ctx.directory, `${fixtureBase}/maestro-contratos.csv`);
    let maestroContent = "";
    try {
      maestroContent = await fs.readFile(maestroPath, "utf-8");
    } catch {
      maestroContent = "";
    }

    const comercialesPath = resolveSafePath(ctx.directory, `${fixtureBase}/comerciales.json`);
    let comercialesRaw = "";
    try {
      comercialesRaw = await fs.readFile(comercialesPath, "utf-8");
    } catch {
      comercialesRaw = "";
    }

    const registryFile = resolveSafePath(ctx.directory, `${outDir}/registros.json`);
    let existingRecords: Array<{
      messageId: string;
      contractNumber: string | null;
      decision: string;
    }> = [];
    try {
      const rawReg = await fs.readFile(registryFile, "utf-8");
      const parsedReg = JSON.parse(rawReg) as unknown;
      if (Array.isArray(parsedReg)) {
        existingRecords = parsedReg as Array<{
          messageId: string;
          contractNumber: string | null;
          decision: string;
        }>;
      }
    } catch {
      existingRecords = [];
    }

    if (extracted.docType === "cotizacion") {
      reasons.push("El documento corresponde a una cotización, no a un contrato ni a un otrosí.");
      return {
        ok: true,
        data: { decision: "rechazado", policyStatus: "n/a", reasons },
      };
    }

    const isForwardedOrDuplicate =
      extracted.subject.toLowerCase().startsWith("fwd:") ||
      extracted.subject.toLowerCase().includes("reenv") ||
      (extracted.contractNumber !== null &&
        maestroContent.includes(extracted.contractNumber) &&
        extracted.docType === "contrato") ||
      existingRecords.some(
        (r) =>
          r.messageId !== messageId &&
          extracted.contractNumber !== null &&
          r.contractNumber === extracted.contractNumber &&
          r.decision !== "rechazado" &&
          r.decision !== "confirmacion_humana"
      );

    if (isForwardedOrDuplicate) {
      reasons.push("El mensaje o contrato ya figura registrado o corresponde a un reenvío duplicado.");
      return {
        ok: true,
        data: { decision: "duplicado", policyStatus: "n/a", reasons },
      };
    }

    const senderInComerciales =
      extracted.sender.trim().length > 0 &&
      comercialesRaw.toLowerCase().includes(extracted.sender.trim().toLowerCase());

    const needsConfirmation =
      extracted.needsHumanReview ||
      !senderInComerciales ||
      extracted.amount === null ||
      extracted.amount <= 0 ||
      extracted.docType === "desconocido";

    if (needsConfirmation) {
      if (!senderInComerciales) {
        reasons.push("Remitente no verificado en comerciales.json.");
      }
      if (extracted.needsHumanReview) {
        reasons.push("El documento o correo contiene datos o condiciones pendientes de revisión.");
      }
      if (extracted.amount === null || extracted.amount <= 0) {
        reasons.push("Monto ausente o no válido.");
      }
      if (extracted.docType === "desconocido") {
        reasons.push("Tipo de documento no identificado con claridad.");
      }
      return {
        ok: true,
        data: { decision: "confirmacion_humana", policyStatus: "n/a", reasons },
      };
    }

    if (extracted.docType === "otrosi") {
      reasons.push("Corresponde a una modificación (otrosí) sobre un contrato existente.");
      return {
        ok: true,
        data: { decision: "otrosi", policyStatus: "n/a", reasons },
      };
    }

    const policyStatus =
  extracted.requiresPolicy === true ? "pendiente" : "no_aplica";
    reasons.push(`Contrato nuevo válido; estado de póliza asignado: ${policyStatus}.`);
    return {
      ok: true,
      data: { decision: "nuevo", policyStatus, reasons },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido en validar";
    return { ok: false, error: message };
  }
}

export async function registrar(
  ctx: ToolContext,
  rawInput: unknown
): Promise<ToolResult<{ persistedTo: string; recordCount: number }>> {
  try {
    const parsed = RegistrarInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `Entrada inválida en registrar: ${parsed.error.message}` };
    }

    if (parsed.data.decision === "confirmacion_humana" && !parsed.data.approvedByHuman) {
      return {
        ok: false,
        error: "Bloqueado: el caso requiere confirmación humana antes de registrarse.",
      };
    }

    const outPath = resolveSafePath(ctx.directory, parsed.data.outDir);
    await fs.mkdir(outPath, { recursive: true });

    const registryFile = path.join(outPath, "registros.json");
    let current: Array<Record<string, unknown>> = [];
    try {
      const existing = await fs.readFile(registryFile, "utf-8");
      const parsedExisting = JSON.parse(existing) as unknown;
      if (Array.isArray(parsedExisting)) {
        current = parsedExisting as Array<Record<string, unknown>>;
      }
    } catch {
      current = [];
    }

    current.push({
      timestamp: new Date().toISOString(),
      messageId: parsed.data.messageId,
      decision: parsed.data.decision,
      approvedByHuman: parsed.data.approvedByHuman,
      contractNumber: parsed.data.extracted.contractNumber,
      counterparty: parsed.data.extracted.counterparty,
      amount: parsed.data.extracted.amount,
      docType: parsed.data.extracted.docType,
    });

    await fs.writeFile(registryFile, JSON.stringify(current, null, 2), "utf-8");

    return {
      ok: true,
      data: {
        persistedTo: path.relative(ctx.directory, registryFile).replaceAll("\\", "/"),
        recordCount: current.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido en registrar";
    return { ok: false, error: message };
  }
}

export async function alertas(
  ctx: ToolContext,
  rawInput: unknown
): Promise<ToolResult<{ alertFile: string }>> {
  try {
    const parsed = AlertasInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: `Entrada inválida en alertas: ${parsed.error.message}` };
    }

    const outPath = resolveSafePath(ctx.directory, parsed.data.outDir);
    await fs.mkdir(outPath, { recursive: true });

    const alertFile = path.join(outPath, "alertas.log");
    const line = `[${new Date().toISOString()}] ${parsed.data.messageId} | estado=${parsed.data.status} | motivo=${parsed.data.reason}\n`;
    await fs.appendFile(alertFile, line, "utf-8");

    return {
      ok: true,
      data: {
        alertFile: path.relative(ctx.directory, alertFile).replaceAll("\\", "/"),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido en alertas";
    return { ok: false, error: message };
  }
}