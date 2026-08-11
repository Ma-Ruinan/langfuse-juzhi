import * as crypto from "crypto";

/**
 * 聚智平台大模型网关 HMAC 鉴权（Juzhi LLM Gateway HMAC Auth）
 *
 * 背景：聚智网关不接受静态 API key，要求每个请求做一次 HMAC-SHA256 签名。
 * Langfuse v4 通过 AI SDK 的 provider fetch 发出请求，因此在该 fetch 上包一层
 * 签名逻辑，是注入「每请求签名」的正确位置。
 *
 * 设计（路线 B）：本文件封装全部聚智特有逻辑；Langfuse 源码只在 buildAiSdkModel
 * 的 OpenAI 分支保留一处薄接入点，按 baseURL 判断是否包装。非聚智连接完全走原路。
 *
 * 注意：真正被 HMAC 签名的只有 host + date + request-line 三部分；
 * modelId / modelSource / traceId 仅作为 Authorization 明文字段，不参与签名，
 * 因此用占位默认值即可。签名不含请求 body，故无需读取/重放请求体。
 */

// TODO(juzhi): 换成聚智网关 baseURL 的真实特征关键字，用于判断是否走 HMAC 鉴权。
const JUZHI_BASEURL_KEYWORD = "juzhi";

// TODO(juzhi): 以下三个字段仅作为 Authorization 明文，不参与签名，按聚智实际情况替换。
const JUZHI_DEFAULT_MODEL_ID = "2c04713c-a4eb-43a1-b977-4afcd856b558";
const JUZHI_DEFAULT_MODEL_SOURCE = "public";
const JUZHI_DEFAULT_TRACE_ID = "1qaz2wsx3edc4rfv5tgb6yhn12345672";

/**
 * 判断给定 baseURL 是否为聚智网关。
 * 这是保证「非聚智模型走正常访问」的唯一开关：不命中则完全不介入。
 */
export function isJuzhiBaseURL(baseURL: string | null | undefined): boolean {
  if (!baseURL) return false;
  return baseURL.includes(JUZHI_BASEURL_KEYWORD);
}

/**
 * 生成 GMT 日期字符串，格式对齐 Python 的 '%a, %d %b %Y %H:%M:%S GMT'。
 * （同事原实现漏了分钟，此处已修正为 时:分:秒。）
 */
function getGMTDateString(): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const now = new Date();
  const dayName = days[now.getUTCDay()];
  const day = String(now.getUTCDate()).padStart(2, "0");
  const monthName = months[now.getUTCMonth()];
  const year = now.getUTCFullYear();
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `${dayName}, ${day} ${monthName} ${year} ${hours}:${minutes}:${seconds} GMT`;
}

/**
 * 生成聚智平台 HMAC Authorization 字符串（最终返回 base64）。
 * 签名内容仅为 host + date + request-line。
 */
function generateJuzhiAuthHeader(params: {
  requestUrl: string;
  apiKey: string;
  apiSecret: string;
  modelId: string;
  modelSource: string;
  traceId: string;
}): string {
  const { requestUrl, apiKey, apiSecret, modelId, modelSource, traceId } =
    params;

  const httpMethod = "POST";
  const httpUrl = requestUrl
    .replace("ws://", "http://")
    .replace("wss://", "https://");
  const apiKeyKey = "hmac api_key";

  const parsedUrl = new URL(httpUrl);
  const hostname = parsedUrl.hostname;
  const path = parsedUrl.pathname;

  const dateStr = getGMTDateString();
  const requestLine = `${httpMethod} ${path} HTTP/1.1`;

  // 真正被签名的内容
  const signingStr = `host: ${hostname}\ndate: ${dateStr}\n${requestLine}`;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signingStr)
    .digest("base64");

  const authString =
    `${apiKeyKey}="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}", ` +
    `modelId="${modelId}", modelSource="${modelSource}", ` +
    `traceId="${traceId}", host="${hostname}", ` +
    `date="${dateStr}", request-line="${requestLine}"`;

  return Buffer.from(authString).toString("base64");
}

/**
 * 把普通 fetch 包装成「每请求自动加聚智 HMAC 签名」的 fetch。
 *
 * @param baseFetch Langfuse 原本的安全 fetch（createFetch 的产物），负责实际发送
 * @param secret    解密后的凭证，格式为 "apiKey:apiSecret"
 */
export function withJuzhiSigning(
  baseFetch: typeof fetch,
  secret: string,
): typeof fetch {
  // 只按第一个冒号拆分，兼容 secret 本身含冒号的情况
  const sepIndex = secret.indexOf(":");
  const apiKey = sepIndex >= 0 ? secret.slice(0, sepIndex) : secret;
  const apiSecret = sepIndex >= 0 ? secret.slice(sepIndex + 1) : "";

  return async (input, init) => {
    // 解析出请求 URL（input 可能是 string / URL / Request）
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const authBase64 = generateJuzhiAuthHeader({
      requestUrl: url,
      apiKey,
      apiSecret,
      modelId: JUZHI_DEFAULT_MODEL_ID,
      modelSource: JUZHI_DEFAULT_MODEL_SOURCE,
      traceId: JUZHI_DEFAULT_TRACE_ID,
    });

    // 合并原有 headers，并用签名覆盖 Authorization
    const headers = new Headers(
      init?.headers ??
        (typeof input !== "string" && !(input instanceof URL)
          ? input.headers
          : undefined),
    );
    // TODO(juzhi): 若网关要求的头名/格式不是 "Authorization: Bearer <base64>"，在此调整。
    headers.set("Authorization", `Bearer ${authBase64}`);

    return baseFetch(url, { ...init, headers });
  };
}
