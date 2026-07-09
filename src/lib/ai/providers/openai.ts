import { AiError } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
}

async function callOpenAi(
  args: ProviderArgs,
  withTemperature: boolean,
): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, temperature } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(withTemperature ? { temperature } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 *
 * `temperature` is sent optimistically. The gpt-5 and o-series models
 * are governed reasoning systems that expose no sampling knob and answer
 * a custom temperature with `400 Unsupported value: 'temperature'`; the
 * account's model is free text, so we can't tell from the id which family
 * it belongs to. Rather than maintain a brittle prefix allow-list that
 * rots with every release, we let the provider decide and retry once
 * without the parameter. Worst case for those models: one wasted
 * round-trip (they reject before generating, so no tokens are billed).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<string> {
  try {
    return await callOpenAi(args, true)
  } catch (err) {
    if (err instanceof AiError && err.code === 'temperature_unsupported') {
      return await callOpenAi(args, false)
    }
    throw err
  }
}
