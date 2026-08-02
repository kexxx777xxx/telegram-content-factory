import type { AiProvider } from '@tcf/shared';

/**
 * The seam between the app and any model vendor. Only Gemini is implemented,
 * but every call site talks to this interface — so the chain runner, rate
 * limiter and prompt resolver never learn a vendor's error shapes or SDK.
 */

export interface LlmGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingBudget?: number;
  /** JSON schema for structured output (topic lists). */
  responseSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmGenerateResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmModelInfo {
  id: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  /** Derived from the catalog, used to filter models per action in the UI. */
  supportsText: boolean;
  supportsImage: boolean;
}

/**
 * How a failure should be treated, decided by the provider adapter so callers
 * never parse vendor error payloads.
 *
 * - `rate_limit`  quota exhausted; carries `retryAfterMs` when the vendor says so
 * - `auth`        key is wrong or revoked — retrying is pointless
 * - `invalid`     our request is malformed; the next model will fail identically
 * - `server`      vendor-side hiccup; the next chain step is worth trying
 * - `timeout`     we gave up waiting
 */
export type LlmErrorKind = 'rate_limit' | 'auth' | 'invalid' | 'server' | 'timeout' | 'unknown';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** A different model on the same key cannot help with these. */
  get isKeyLevel(): boolean {
    return this.kind === 'auth';
  }

  /** Retrying the same step later may succeed. */
  get isTransient(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'timeout';
  }
}

export interface LlmImageRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

export interface LlmImageResult {
  data: Buffer;
  mimeType: string;
  model: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: AiProvider;
  generate(apiKey: string, request: LlmGenerateRequest): Promise<LlmGenerateResult>;
  /** Absent when the provider has no image models. */
  generateImage?(apiKey: string, request: LlmImageRequest): Promise<LlmImageResult>;
  listModels(apiKey: string): Promise<LlmModelInfo[]>;
}
