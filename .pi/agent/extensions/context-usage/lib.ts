/**
 * Pure formatting for the context_usage tool. No pi imports, so plain Node
 * tests can import this file.
 */

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ModelLike {
  provider?: string;
  id?: string;
}

export interface FormattedContextUsage {
  text: string;
  details: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    model: string;
    thinkingLevel: string | null;
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "?";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

export function formatContextUsage(
  usage: ContextUsageLike | null | undefined,
  model?: ModelLike | null,
  thinking?: string | null,
): FormattedContextUsage {
  const modelName =
    model && model.id
      ? model.provider
        ? `${model.provider}/${model.id}`
        : String(model.id)
      : "unknown";
  const thinkingLevel = thinking ?? null;
  const tail = `model: ${modelName}${
    thinkingLevel ? `\nthinking: ${thinkingLevel}` : ""
  }`;

  if (!usage) {
    return {
      text: `context: unknown (no active model or context window available)\n${tail}`,
      details: {
        tokens: null,
        contextWindow: null,
        percent: null,
        model: modelName,
        thinkingLevel,
      },
    };
  }

  const windowStr = formatTokenCount(usage.contextWindow);
  if (usage.tokens == null) {
    return {
      text: `context: unknown until the next response (fresh after compaction)\ncontext window: ${windowStr}\n${tail}`,
      details: {
        tokens: null,
        contextWindow: usage.contextWindow,
        percent: null,
        model: modelName,
        thinkingLevel,
      },
    };
  }

  const percent =
    usage.percent != null
      ? usage.percent
      : usage.contextWindow > 0
        ? (usage.tokens / usage.contextWindow) * 100
        : null;
  const percentStr = percent != null ? `${percent.toFixed(1)}%` : "?";
  return {
    text: `context: ${formatTokenCount(usage.tokens)} / ${windowStr} (${percentStr})\n${tail}`,
    details: {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent,
      model: modelName,
      thinkingLevel,
    },
  };
}
