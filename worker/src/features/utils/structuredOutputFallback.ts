// 本文是新增文件
import { z as zodV3 } from "zod/v3";

/**
 * 手工结构化输出兜底（Manual Structured Output Fallback）
 *
 * 背景：
 *   聚智网关内的部分模型不支持 function calling 原生结构化输出。
 *   Langfuse v4 默认通过 AI SDK 的 `Output.object` 让模型直接返回结构化对象，这依赖上述能力，
 *   因此在这些网关上会失败（表现为 could not parse the response / Invalid JSON）。
 *
 * 本文件提供两个纯函数，替代原生结构化输出：
 *   1. appendJsonOutputInstruction：在提示词末尾追加一段硬性格式要求，让模型只
 *      输出一个裸 JSON 对象 { reasoning, score }。
 *   2. parseStructuredLLMText：把模型返回的纯文本稳健地解析成 { reasoning, score }，
 *      并用调用方传入的 Zod schema 做最终校验，保证下游拿到的形状与原生路径一致。
 *
 * 设计原则：
 *   - 不改动 evalService 的下游校验逻辑；解析产物必须能通过传入的
 *     outputResultSchema 校验（数值 / 布尔 / 分类三种输出类型均适用）。
 *   - 解析彻底失败时抛出带原文的错误，让该评测任务显式失败，而非静默给出 0 分。
 */

/**
 * 追加到提示词末尾的 JSON 格式约束。
 *
 * 说明：具体的评分标准已经写在评估器 schema 的字段描述里、并会体现在评测语义中，
 * 这里只负责强制「输出格式」，让模型只回一个可被机器解析的 JSON 对象，
 * 不带 markdown 代码块或多余文字。
 */
export const JSON_OUTPUT_INSTRUCTION = `

IMPORTANT: Respond with ONLY a single raw JSON object, and nothing else.
The object must contain exactly these two fields:
{
  "reasoning": "<a concise explanation of your evaluation, as a string>",
  "score": <the score, following the scoring criteria described above>
}
Do NOT wrap the JSON in markdown code fences (no triple backticks), and do NOT
add any text before or after the JSON object.`;

/**
 * 在最后一条消息末尾追加 JSON 格式约束，返回新的消息数组（不改动原数组）。
 *
 * 之所以追加到最后一条、而非新增一条消息，是为了让约束紧跟在评测指令之后，
 * 与同事 v3.84.0 的做法保持一致，也避免多加一轮 user 消息干扰部分模型。
 *
 * 泛型约束为「带 string 类型 content 字段的对象」，正好匹配 buildEvalMessages
 * 产出的消息形状，无需耦合具体的 ChatMessage 联合类型。
 */
export function appendJsonOutputInstruction<T extends { content: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length === 0) {
    return [...messages];
  }

  const lastIndex = messages.length - 1;
  return messages.map((message, index) => {
    if (index !== lastIndex) {
      return message;
    }
    return {
      ...message,
      content: `${message.content}${JSON_OUTPUT_INSTRUCTION}`,
    };
  });
}

/**
 * 从模型返回的纯文本中稳健地解析出 { reasoning, score }。
 *
 * 处理链路（逐级兜底）：
 *   1. 去掉可能包裹的 markdown 代码块（```json ... ```）。
 *   2. 直接 JSON.parse；失败则用正则抓取第一个 {...} 片段再 parse。
 *   3. 若结果被单层对象包裹（如 { result: {...} }）则解包。
 *   4. 用字段别名兼容不同模型的命名（score / value；reasoning / comment 等）。
 *   5. 用调用方传入的 schema 做最终校验；数值 / 布尔型分数若为字符串则尝试轻量
 *      强转后重试，以适配「把数字或布尔当字符串输出」的模型。
 *   6. 全部失败则抛出带原文的错误，让该评测任务显式失败。
 *
 * @param text   模型返回的原始文本
 * @param schema evalService 传入的 outputResultSchema（{ reasoning, score } 形状）
 * @returns      通过 schema 校验后的对象
 */
export function parseStructuredLLMText<T>(
  text: string,
  schema: zodV3.ZodType<T>,
): T {
  const rawText = typeof text === "string" ? text : JSON.stringify(text);

  // 1. 去掉 markdown 代码块包裹
  let jsonText = rawText.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }

  // 2. 解析 JSON：先直接 parse，失败再抓第一个花括号片段
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const braceMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!braceMatch) {
      throw new Error(
        `Failed to parse structured LLM response as JSON. Raw text: "${rawText}"`,
      );
    }
    parsed = JSON.parse(braceMatch[0]);
  }

  // 3. 解包单层包裹，如 { result: { score, reasoning } }
  if (
    parsed &&
    typeof parsed === "object" &&
    !("score" in parsed) &&
    !("reasoning" in parsed)
  ) {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (
      keys.length === 1 &&
      typeof (parsed as Record<string, unknown>)[keys[0]] === "object"
    ) {
      parsed = (parsed as Record<string, unknown>)[keys[0]];
    }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;

  // 4. 字段别名兼容
  const rawScore: unknown =
    obj.score ?? obj.value ?? obj.correctness_score ?? obj.correctness;
  let reasoning: unknown =
    obj.reasoning ?? obj.comment ?? obj.explanation ?? obj.reason;

  // reasoning 兜底：取第一个非 score 的字符串字段
  if (reasoning === undefined) {
    for (const key of Object.keys(obj)) {
      if (key !== "score" && typeof obj[key] === "string") {
        reasoning = obj[key];
        break;
      }
    }
  }

  const normalizedReasoning = reasoning === undefined ? "" : String(reasoning);

  // 5. 用 schema 校验；失败则对数值 / 布尔做一次轻量强转后重试
  const firstAttempt = schema.safeParse({
    reasoning: normalizedReasoning,
    score: rawScore,
  });
  if (firstAttempt.success) {
    return firstAttempt.data;
  }

  const coercedScore = coerceScore(rawScore);
  if (coercedScore !== undefined) {
    const secondAttempt = schema.safeParse({
      reasoning: normalizedReasoning,
      score: coercedScore,
    });
    if (secondAttempt.success) {
      return secondAttempt.data;
    }
  }

  // 6. 彻底失败：抛出带原文的错误，交由上层标记任务失败
  throw new Error(
    `Structured LLM response did not match the expected schema. ` +
      `Parsed score="${String(rawScore)}". Raw text: "${rawText}"`,
  );
}

/**
 * 轻量分数强转：把字符串数字转 number，把 "true"/"false" 转 boolean。
 * 仅在首次 schema 校验失败时兜底使用，转不动就返回 undefined。
 */
function coerceScore(score: unknown): number | boolean | undefined {
  if (typeof score === "string") {
    const trimmed = score.trim().toLowerCase();
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
    const num = Number.parseFloat(trimmed);
    if (!Number.isNaN(num)) {
      return num;
    }
  }
  return undefined;
}
