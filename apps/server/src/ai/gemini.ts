import { GoogleGenAI } from '@google/genai';
import {
  LlmError,
  type LlmGenerateRequest,
  type LlmGenerateResult,
  type LlmImageRequest,
  type LlmImageResult,
  type LlmModelInfo,
  type LlmProvider,
} from './provider.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Gemini adapter. Its whole job beyond calling the SDK is turning vendor errors
 * into the small `LlmErrorKind` vocabulary — that classification is what lets
 * the chain runner decide between "skip this model", "skip this key" and
 * "stop, our request is broken".
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;

  async generate(apiKey: string, request: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const ai = new GoogleGenAI({ apiKey });
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const config: Record<string, unknown> = {};
    if (request.system) config.systemInstruction = request.system;
    if (request.temperature !== undefined) config.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens;
    if (request.thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget: request.thinkingBudget };
    }
    if (request.responseSchema) {
      config.responseMimeType = 'application/json';
      config.responseSchema = request.responseSchema;
    }

    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model: request.model,
          contents: request.prompt,
          config,
        }),
        timeoutMs,
        request.model,
      );

      const text = response.text ?? '';
      if (!text.trim()) {
        // An empty body usually means a safety block or a truncated thinking
        // budget; both are worth trying the next model for, not retrying here.
        throw new LlmError('server', `Модель ${request.model} повернула порожню відповідь`);
      }

      return {
        text,
        model: request.model,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      throw classify(err, request.model);
    }
  }

  /**
   * Image models answer with inline base64 parts rather than text, so this is a
   * separate method instead of a flag on `generate`.
   */
  async generateImage(apiKey: string, request: LlmImageRequest): Promise<LlmImageResult> {
    const ai = new GoogleGenAI({ apiKey });
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const response = await withTimeout(
        ai.models.generateContent({ model: request.model, contents: request.prompt }),
        timeoutMs,
        request.model,
      );

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const image = parts.find((part) => part.inlineData?.data);
      if (!image?.inlineData?.data) {
        // A refusal or safety block arrives as text with no image part.
        const text = response.text?.trim();
        throw new LlmError(
          'server',
          `Модель ${request.model} не повернула зображення${text ? `: ${text.slice(0, 160)}` : ''}`,
        );
      }

      return {
        data: Buffer.from(image.inlineData.data, 'base64'),
        mimeType: image.inlineData.mimeType ?? 'image/png',
        model: request.model,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (err) {
      throw classify(err, request.model);
    }
  }

  async listModels(apiKey: string): Promise<LlmModelInfo[]> {
    const ai = new GoogleGenAI({ apiKey });
    const models: LlmModelInfo[] = [];

    try {
      for await (const model of await ai.models.list()) {
        const actions = model.supportedActions ?? [];
        if (!actions.includes('generateContent')) continue;

        const id = (model.name ?? '').replace(/^models\//, '');
        if (!id) continue;

        models.push({
          id,
          displayName: model.displayName ?? id,
          inputTokenLimit: model.inputTokenLimit ?? 0,
          outputTokenLimit: model.outputTokenLimit ?? 0,
          supportsText: true,
          // The catalog exposes no capability flag for this, so the id is the
          // only signal available. Kept in one place so it is easy to correct.
          supportsImage: /-image|nano-banana/.test(id),
        });
      }
    } catch (err) {
      throw classify(err, 'models.list');
    }

    return models.sort((a, b) => a.id.localeCompare(b.id));
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, model: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmError('timeout', `Таймаут ${ms} мс для ${model}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Gemini reports quota exhaustion as 429 with a `RetryInfo` detail carrying
 * `retryDelay: "42s"`. That number is the whole point: it becomes
 * `rate_limit_state.blocked_until`, so every other worker skips the pair
 * instead of rediscovering the limit one request at a time.
 */
function classify(err: unknown, model: string): LlmError {
  if (err instanceof LlmError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const status = extractStatus(err, message);

  if (status === 429) {
    return new LlmError('rate_limit', `Квоту вичерпано для ${model}: ${message}`, extractRetryDelayMs(err, message), 429);
  }
  if (status === 401 || status === 403) {
    return new LlmError('auth', `Ключ відхилено (${status}): ${message}`, undefined, status);
  }
  if (status === 400 || status === 404) {
    return new LlmError('invalid', `Некоректний запит або невідома модель ${model}: ${message}`, undefined, status);
  }
  if (status !== undefined && status >= 500) {
    return new LlmError('server', `Помилка провайдера (${status}): ${message}`, undefined, status);
  }
  if (/abort|timeout|ETIMEDOUT/i.test(message)) {
    return new LlmError('timeout', `Таймаут запиту до ${model}: ${message}`);
  }
  return new LlmError('unknown', message);
}

function extractStatus(err: unknown, message: string): number | undefined {
  if (err && typeof err === 'object') {
    const candidate = err as { status?: unknown; code?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.code === 'number') return candidate.code;
  }
  const match = /\b(4\d{2}|5\d{2})\b/.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

function extractRetryDelayMs(err: unknown, message: string): number | undefined {
  const fromDetails = findRetryDelay(err);
  if (fromDetails !== undefined) return fromDetails;

  const match = /"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i.exec(message);
  return match?.[1] ? Math.round(Number(match[1]) * 1000) : undefined;
}

function findRetryDelay(value: unknown, depth = 0): number | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRetryDelay(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const raw = record.retryDelay;
  if (typeof raw === 'string') {
    const seconds = Number.parseFloat(raw.replace(/s$/, ''));
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }

  for (const nested of Object.values(record)) {
    const found = findRetryDelay(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const geminiProvider = new GeminiProvider();

export const providers: Record<string, LlmProvider> = {
  gemini: geminiProvider,
};
