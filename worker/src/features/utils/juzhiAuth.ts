import * as crypto from "crypto";
import { URL } from "url";

/**
 * 聚智平台大模型网关 HMAC 鉴权 —— Langfuse v3.84.0
 */

// TODO(juzhi): 后续替换为真实聚智网关 baseURL 的特征关键字
const JUZHI_BASEURL_KEYWORD = "juzhi";

// TODO(juzhi): 后续根据聚智实际参数调整
const JUZHI_DEFAULT_MODEL_ID = "2c04713c-a4eb-43a1-b977-4afcd856b558";

const JUZHI_DEFAULT_MODEL_SOURCE = "public";

// traceId 获取失败时使用；不参与 HMAC 签名
export const JUZHI_DEFAULT_TRACE_ID = "1qaz2wsx3edc4rfv5tgb6yhn12345672";

/**
 * 判断当前连接是否为聚智网关。
 * 非聚智连接完全不介入。
 */
export function isJuzhiBaseURL(baseURL: string | null | undefined): boolean {
  if (!baseURL) return false;
  return baseURL.includes(JUZHI_BASEURL_KEYWORD);
}

/**
 * GMT 时间：
 * Wed, 15 Aug 2026 12:34:56 GMT
 */
function getGMTDateString(): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
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
 * 生成聚智 HMAC Authorization 内容，最终返回 base64。
 *
 * HMAC 实际签名内容：
 * host + date + request-line
 */
export function generateJuzhiAuthHeader(params: {
  requestUrl: string;
  apiKey: string;
  apiSecret: string;
  traceId: string;
  modelId?: string;
  modelSource?: string;
}): string {
  const {
    requestUrl,
    apiKey,
    apiSecret,
    traceId,
    modelId = JUZHI_DEFAULT_MODEL_ID,
    modelSource = JUZHI_DEFAULT_MODEL_SOURCE,
  } = params;

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

  const signingStr =
    `host: ${hostname}\n` + `date: ${dateStr}\n` + `${requestLine}`;

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
