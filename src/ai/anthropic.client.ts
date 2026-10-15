import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { ApiException } from '../common/errors/api.exception';

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string | AiContentBlock[];
}

export interface AiResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/// Cliente mínimo da API de mensagens da Anthropic (Claude), por fetch.
@Injectable()
export class AnthropicClient {
  private readonly logger = new Logger(AnthropicClient.name);

  get enabled() {
    return !!env().ANTHROPIC_API_KEY;
  }

  async complete(input: { model: string; system: string; messages: AiMessage[]; maxTokens?: number; temperature?: number }): Promise<AiResult> {
    const key = env().ANTHROPIC_API_KEY;
    if (!key) throw ApiException.unavailable('AI_NOT_CONFIGURED');
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          ...(env().ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env().ANTHROPIC_WORKSPACE_ID as string } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxTokens ?? 1024,
          system: input.system,
          messages: input.messages,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      this.logger.warn(`IA sem resposta: ${(err as Error).message}`);
      throw ApiException.unavailable('AI_FAILED');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn(`IA respondeu ${response.status}: ${body.slice(0, 300)}`);
      throw ApiException.unavailable('AI_FAILED');
    }
    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n').trim();
    return { text, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
  }
}

/// Tira o primeiro objeto JSON de uma resposta (com ou sem ```json).
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
