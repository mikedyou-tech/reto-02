import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

export interface AgentSummaryInput {
  directory: string;
  messageId: string;
  decision: string;
  policyStatus: string;
  reasons: string[];
  model?: string;
}

export async function summarizeCaseWithGemini(
  input: AgentSummaryInput
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        error: "Falta la variable de entorno GEMINI_API_KEY en la terminal.",
      };
    }

    const promptPath = path.resolve(input.directory, "agent/prompt.md");
    const knowledgePath = path.resolve(
      input.directory,
      "src/knowledge/registro-contratos.md"
    );

    const systemPrompt = await fs.readFile(promptPath, "utf-8");
    const knowledge = await fs.readFile(knowledgePath, "utf-8");

    const ai = new GoogleGenAI({ apiKey });
    const modelName = input.model ?? "gemini-3.5-flash-lite";

    const userPrompt = [
      `Conocimiento del dominio:\n${knowledge}`,
      `Caso evaluado: ${input.messageId}`,
      `Decisión: ${input.decision}`,
      `Estado de póliza: ${input.policyStatus}`,
      `Motivos: ${input.reasons.join(" ")}`,
      "Redacta una respuesta breve y clara en español indicando qué ocurre con este caso.",
    ].join("\n\n");

    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
      },
    });

    return {
      ok: true,
      text: response.text ?? "Sin respuesta de texto del modelo.",
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Error al consultar el modelo de Gemini.";
    return { ok: false, error: message };
  }
}