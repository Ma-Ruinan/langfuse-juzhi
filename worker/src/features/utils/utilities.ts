import {
  ChatMessage,
  decryptAndParseExtraHeaders,
  fetchLLMCompletion,
  logger,
  type TraceParams,
} from "@langfuse/shared/src/server";
import { ApiError, LLMApiKeySchema, ZodModelConfig } from "@langfuse/shared";
import { z } from "zod/v4";
import { z as zodV3 } from "zod/v3";
import { ZodSchema as ZodV3Schema } from "zod/v3";
import { decrypt } from "@langfuse/shared/encryption";
import { tokenCount } from "../tokenisation/usage";
import Handlebars from "handlebars";
// JUZHI-ADAPTER HOOK: 聚智适配新增导入
import { prisma } from "@langfuse/shared/src/db";

import {
  isJuzhiBaseURL,
  generateJuzhiAuthHeader,
  JUZHI_DEFAULT_TRACE_ID,
} from "./juzhiAuth";

import {
  appendJsonOutputInstruction,
  parseStructuredLLMText,
} from "./structuredOutputFallback";

/**
 * Standard error handling for LLM operations
 * Handles common LLM errors like quota limits and throttling with appropriate status codes
 *
 * @param operation - The async LLM operation to execute
 * @param operationName - Name for error context (e.g., "call LLM")
 * @returns The result of the operation or throws an ApiError
 */
async function withLLMErrorHandling<T>(
  operation: () => Promise<T>,
  operationName: string = "LLM operation",
): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    // Handle specific LLM provider errors with appropriate status codes
    if (
      e instanceof Error &&
      (e.name === "InsufficientQuotaError" || e.name === "ThrottlingException")
    ) {
      throw new ApiError(e.name, 429);
    }

    // Handle all other errors with preserved status codes
    throw new ApiError(
      `Failed to ${operationName}: ${e}`,
      (e as any)?.response?.status ?? (e as any)?.status,
    );
  }
}

// export async function callStructuredLLM<T extends ZodV3Schema>(
//   jeId: string,
//   llmApiKey: z.infer<typeof LLMApiKeySchema>,
//   messages: ChatMessage[],
//   modelParams: z.infer<typeof ZodModelConfig>,
//   provider: string,
//   model: string,
//   structuredOutputSchema: T,
// ): Promise<zodV3.infer<T>> {
//   return withLLMErrorHandling(async () => {
//     const { completion } = await fetchLLMCompletion({
//       streaming: false,
//       apiKey: decrypt(llmApiKey.secretKey), // decrypt the secret key
//       extraHeaders: decryptAndParseExtraHeaders(llmApiKey.extraHeaders),
//       baseURL: llmApiKey.baseURL || undefined,
//       messages,
//       modelParams: {
//         provider,
//         model,
//         adapter: llmApiKey.adapter,
//         ...modelParams,
//       },
//       structuredOutputSchema,
//       config: llmApiKey.config,
//       maxRetries: 1,
//     });

//     return structuredOutputSchema.parse(completion);
//   }, "call LLM");
// }
export async function callStructuredLLM<T extends ZodV3Schema>(
  jeId: string,
  llmApiKey: z.infer<typeof LLMApiKeySchema>,
  messages: ChatMessage[],
  modelParams: z.infer<typeof ZodModelConfig>,
  provider: string,
  model: string,
  structuredOutputSchema: T,
): Promise<zodV3.infer<T>> {
  return withLLMErrorHandling(async () => {
    const baseURL = llmApiKey.baseURL || undefined;

    // JUZHI-ADAPTER HOOK:
    // 聚智 baseURL -> HMAC 动态鉴权
    // 普通模型 -> 保持 Langfuse 原来的 API Key 行为
    let apiKeyToUse: string;

    if (isJuzhiBaseURL(baseURL)) {
      // 1. 获取 traceId。
      // traceId 只作为 Authorization 明文字段，不参与 HMAC 签名。
      let traceId = JUZHI_DEFAULT_TRACE_ID;

      try {
        const job = await prisma.jobExecution.findUnique({
          where: { id: jeId },
          select: { jobInputTraceId: true },
        });

        if (job?.jobInputTraceId) {
          traceId = job.jobInputTraceId;
        }
      } catch (dbError) {
        logger.error(
          "Failed to fetch trace ID from DB for Juzhi Gateway HMAC:",
          dbError,
        );
      }

      // 2. Langfuse 中聚智凭证按：
      //
      // apiKey:apiSecret
      //
      // 的形式保存。
      const decryptedSecret = decrypt(llmApiKey.secretKey);

      const sepIndex = decryptedSecret.indexOf(":");

      const juzhiApiKey =
        sepIndex >= 0
          ? decryptedSecret.slice(0, sepIndex)
          : decryptedSecret;

      const juzhiApiSecret =
        sepIndex >= 0
          ? decryptedSecret.slice(sepIndex + 1)
          : "";

      // 3. 动态生成聚智 HMAC Authorization 内容。
      apiKeyToUse = generateJuzhiAuthHeader({
        requestUrl: baseURL as string,
        apiKey: juzhiApiKey,
        apiSecret: juzhiApiSecret,
        traceId,
      });
    } else {
      // 非聚智连接完全维持 Langfuse 原行为
      apiKeyToUse = decrypt(llmApiKey.secretKey);
    }

    // JUZHI-ADAPTER HOOK:
    // 非 FC 模型结构化输出兜底。
    //
    // 原来：
    //   structuredOutputSchema -> 原生 structured output
    //
    // 现在：
    //   普通文本 -> JSON -> 手工解析 -> 原 schema 校验

    const patchedMessages =
      appendJsonOutputInstruction(messages);

    const { completion } =
      await fetchLLMCompletion({
        streaming: false,

        apiKey: apiKeyToUse,

        extraHeaders:
          decryptAndParseExtraHeaders(
            llmApiKey.extraHeaders,
          ),

        baseURL,

        messages: patchedMessages,

        modelParams: {
          provider,
          model,
          adapter: llmApiKey.adapter,
          ...modelParams,
        },

        // 关键：
        // 不向底层传 structuredOutputSchema，
        // 从而绕过 function calling / 原生结构化输出。
        structuredOutputSchema: undefined,

        config: llmApiKey.config,

        maxRetries: 1,
      });

    // 将模型返回的普通文本手工解析，
    // 最后仍使用 Langfuse 原来的 schema 做校验。
    return parseStructuredLLMText(
      completion,
      structuredOutputSchema,
    );
  }, "call LLM");
}

export async function callLLM(
  llmApiKey: z.infer<typeof LLMApiKeySchema>,
  messages: ChatMessage[],
  modelParams: z.infer<typeof ZodModelConfig>,
  provider: string,
  model: string,
  traceParams?: Omit<TraceParams, "tokenCountDelegate">,
): Promise<string> {
  return withLLMErrorHandling(async () => {
    const { completion, processTracedEvents } = await fetchLLMCompletion({
      streaming: false,
      apiKey: decrypt(llmApiKey.secretKey),
      extraHeaders: decryptAndParseExtraHeaders(llmApiKey.extraHeaders),
      baseURL: llmApiKey.baseURL || undefined,
      messages,
      modelParams: {
        provider,
        model,
        adapter: llmApiKey.adapter,
        ...modelParams,
      },
      config: llmApiKey.config,
      traceParams: traceParams
        ? { ...traceParams, tokenCountDelegate: tokenCount }
        : undefined,
      maxRetries: 1,
      throwOnError: false,
    });

    if (traceParams) {
      await processTracedEvents();
    }

    return completion;
  }, "call LLM");
}

export function compileHandlebarString(
  handlebarString: string,
  context: Record<string, any>,
): string {
  try {
    const template = Handlebars.compile(handlebarString, { noEscape: true });
    return template(context);
  } catch (error) {
    logger.info("Handlebars compilation error:", error);
    return handlebarString; // Fallback to the original string if Handlebars fails
  }
}
