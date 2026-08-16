import {
  getObservationsForTrace,
  logger,
} from "@langfuse/shared/src/server";

/**
 * 聚智内置 TTFT 指标（Ours TTFT）—— 确定性计算，不经过 LLM。
 *
 * 设计（路线 B / 解耦）：本文件封装 TTFT 全部特有逻辑（识别、阈值分档、
 * 读时间戳、算首 token 耗时、遍历 trace 下的 generation）。evalService 只在
 * 拿到 template 后保留一处薄接入点（JUZHI-ADAPTER HOOK），识别到本指标就
 * 调用 evaluateTtftForTrace 拿到「每个 generation 的分档结果」，逐条写
 * CATEGORICAL 分数后直接返回，不走 LLM 裁判流程。
 *
 * TTFT = completionStartTime - startTime（毫秒）。仅流式且上报了
 * completion_start_time 的 generation 才算得出；否则记为 "unknown"。
 */

// 内置 TTFT 指标在 managed-evaluators.json 中的固定 id。
// evalService 用它识别「当前跑的是不是 TTFT 指标」。
export const TTFT_TEMPLATE_ID = "ours-ttft-managed-evaluator";

// TODO(ttft): 业务标准确定后，只需改这里的阈值区间再重新发布服务即可。
// 分档（左闭右开）：
//   [0,100) good | [100,200) medium | [200,300) soso | >=300 bad
const TTFT_THRESHOLDS = {
  good: 100,
  medium: 200,
  soso: 300,
} as const;

export type TtftBucket = "good" | "medium" | "soso" | "bad";

export function isTtftEvaluator(templateId: string): boolean {
  return templateId === TTFT_TEMPLATE_ID;
}

/** 按毫秒数分档。 */
export function classifyTtft(ttftMs: number): TtftBucket {
  if (ttftMs < TTFT_THRESHOLDS.good) return "good";
  if (ttftMs < TTFT_THRESHOLDS.medium) return "medium";
  if (ttftMs < TTFT_THRESHOLDS.soso) return "soso";
  return "bad";
}

// 单个 generation 的 TTFT 结果
export type TtftPerObservation = {
  observationId: string;
  value: TtftBucket | "unknown";
  comment: string;
  environment: string;
};

/**
 * 遍历一条 trace 下所有 GENERATION 观测，逐个算 TTFT 并分档。
 * 返回每个 generation 的分档结果，交由 evalService 逐条写 CATEGORICAL 分数。
 *
 * 拿不到 completion_start_time（非流式 / 未上报）的 generation 记为 unknown。
 */
export async function evaluateTtftForTrace(params: {
  traceId: string;
  projectId: string;
}): Promise<TtftPerObservation[]> {
  const { traceId, projectId } = params;

  const observations = await getObservationsForTrace({
    traceId,
    projectId,
    includeIO: false,
  });

  // 只评 GENERATION 类型（只有它才有首 token 时间的意义）
  const generations = observations.filter((o) => o.type === "GENERATION");

  if (generations.length === 0) {
    logger.debug(`TTFT: trace ${traceId} has no GENERATION observations.`);
    return [];
  }

  return generations.map((o) => {
    const environment = o.environment ?? "default";
    const startTime = o.startTime ?? null;
    const completionStartTime = o.completionStartTime ?? null;

    if (!startTime || !completionStartTime) {
      return {
        observationId: o.id,
        value: "unknown",
        comment:
          "No usable TTFT: missing completion_start_time (target is likely not a streaming generation, or the field was not reported).",
        environment,
      };
    }

    const ttftMs = completionStartTime.getTime() - startTime.getTime();
    if (Number.isNaN(ttftMs) || ttftMs < 0) {
      return {
        observationId: o.id,
        value: "unknown",
        comment: `No usable TTFT: invalid time values (start=${startTime.toISOString()}, completionStart=${completionStartTime.toISOString()}).`,
        environment,
      };
    }

    return {
      observationId: o.id,
      value: classifyTtft(ttftMs),
      comment: `TTFT = ${ttftMs} ms`,
      environment,
    };
  });
}
