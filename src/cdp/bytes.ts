/**
 * Response bytes through the user's Chrome (P12-A).
 *
 * Why not `fetch()` in Node: the bytes we need are the ones the *browser* would
 * receive — behind its cookies, its redirects and its compression. The user is
 * already logged in there, and P12 never adds a second network stack.
 *
 * Why a detached capture target instead of the read tab: Chrome's PDF viewer
 * replaces the document with an out-of-process extension, so a request for a
 * PDF made in that tab may be answered with the viewer's HTML rather than the
 * document (measured 2026-11-06, `evidence/P12-spike.md`). A short-lived,
 * background target keeps the capture independent of whatever the visible tab
 * is showing and is closed before the caller sees the bytes.
 *
 * The capture is a `Fetch` interception at the response stage: the request is
 * issued by the page (`fetch(url)`), paused by CDP, read with
 * `Fetch.getResponseBody`, and then *failed* so Chrome never renders it. No
 * DNS or TLS work happens outside the browser, and the SSRf guard gets the
 * final URL after redirects to re-check.
 *
 * Hard rules respected here: this never launches a browser, never navigates or
 * closes a tab it did not create, and never writes into the profile.
 */

import { isWebSearchError } from "../runtime/error-codes.ts";
import { fail } from "../runtime/errors.ts";
import type { CdpSession } from "./session.ts";
import type { FetchedBytes, FetchBytesOptions } from "./types.ts";

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  for (const entry of headers) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.name === "string" ? entry.name.toLowerCase() : "";
    if (key !== wanted) continue;
    return typeof entry.value === "string" ? entry.value : undefined;
  }
  return undefined;
}

function mimeOf(headers: unknown): string {
  const raw = headerValue(headers, "content-type") ?? "";
  const [mime] = raw.split(";");
  return (mime ?? "").trim().toLowerCase();
}

function contentLength(headers: unknown): number | undefined {
  const raw = headerValue(headers, "content-length");
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bound a promise so a paused request can never hang the read lock. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, url: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        fail("E_TIMEOUT", "read", {
          message: `fetching ${new URL(url).host} did not finish within ${timeoutMs}ms`,
          hint: "retry; a slow host or a streaming response can exceed the fetch deadline",
        }),
      );
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Capture a URL's response body through the attached browser.
 *
 * The caller is responsible for the *requested* URL's SSRF check; `bytes.ts`
 * re-checks nothing because it does not know the resolver. `FetchedBytes.url`
 * is the final hop, and the tool re-runs the guard on it before using the body.
 */
export async function captureBytes(
  session: CdpSession,
  url: string,
  options: FetchBytesOptions = {},
): Promise<FetchedBytes> {
  if (options.signal?.aborted === true) {
    throw fail("E_CANCELLED", "read", { message: "the byte fetch was aborted before it started" });
  }
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1, Math.floor(options.maxBytes as number)) : DEFAULT_MAX_BYTES;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs as number))
    : DEFAULT_FETCH_TIMEOUT_MS;
  const ceilingKey = options.ceilingKey?.trim() || "read.pdfMaxBytes";

  let targetId: string | undefined;
  let sessionId: string | undefined;
  try {
    // `background: true` keeps the user's foreground tab where it is; Chrome
    // 132+ accepts it and older builds ignore the flag rather than failing.
    targetId = await session.createTarget("about:blank", { background: true });
    await session.attach(targetId);
    sessionId = session.sessionIdFor(targetId);
    if (sessionId === undefined) {
      throw fail("E_CDP_DISCONNECTED", "connect", { message: "the capture target is not attached" });
    }
    const captureSessionId = sessionId;

    await session.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Response" }] },
      captureSessionId,
    );

    const outcome = await withDeadline(
      new Promise<FetchedBytes>((resolve, reject) => {
        let settled = false;
        let onEvent: (() => void) | undefined;
        const onAbort = (): void => {
          finish(() =>
            reject(fail("E_CANCELLED", "read", { message: "the byte fetch was aborted by the caller" })),
          );
        };
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          onEvent?.();
          options.signal?.removeEventListener("abort", onAbort);
          fn();
        };

        const handler = (params: unknown, eventSessionId?: string): void => {
          if (settled || eventSessionId !== captureSessionId) return;
          const paused: Record<string, unknown> = isRecord(params) ? params : {};
          const requestId = typeof paused.requestId === "string" ? paused.requestId : undefined;
          if (requestId === undefined) return;

          const status = typeof paused.responseStatusCode === "number" ? paused.responseStatusCode : 0;
          const headers = paused.responseHeaders;
          const request = isRecord(paused.request) ? paused.request : {};
          const finalUrl = typeof request.url === "string" ? request.url : url;

          // Redirects are part of the chain; keep following until the body hop.
          if (status >= 300 && status < 400) {
            void session
              .send("Fetch.continueResponse", { requestId }, captureSessionId)
              .catch(() => undefined);
            return;
          }

          const declared = contentLength(headers);
          if (declared !== undefined && declared > maxBytes) {
            void session.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, captureSessionId).catch(
              () => undefined,
            );
            finish(() =>
              reject(
                fail("E_UNSUPPORTED", "read", {
                  message:
                    `the response is ${formatBytes(declared)} (${declared} bytes), over the ` +
                    `${formatBytes(maxBytes)} ceiling (${ceilingKey})`,
                  hint:
                    `raise ${ceilingKey} or read the HTML version; a huge payload is refused before ` +
                    "its body is downloaded",
                }),
              ),
            );
            return;
          }

          void (async () => {
            try {
              const body = await session.send<Record<string, unknown>>(
                "Fetch.getResponseBody",
                { requestId },
                captureSessionId,
              );
              const encoded = body.base64Encoded === true;
              const raw = typeof body.body === "string" ? body.body : "";
              const bytes = Buffer.from(raw, encoded ? "base64" : "utf8");
              // A server may omit Content-Length (chunked); the ceiling is still
              // enforced, just after the transfer instead of before it.
              if (bytes.length > maxBytes) {
                throw fail("E_UNSUPPORTED", "read", {
                  message:
                    `the response is ${formatBytes(bytes.length)} (${bytes.length} bytes), over the ` +
                    `${formatBytes(maxBytes)} ceiling (${ceilingKey})`,
                  hint: `raise ${ceilingKey} or read the HTML version; a huge payload is not shipped to the agent`,
                });
              }
              finish(() =>
                resolve({ url: finalUrl, status: status === 0 ? 200 : status, contentType: mimeOf(headers), bytes }),
              );
            } catch (error) {
              finish(() => reject(error));
            } finally {
              void session
                .send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, captureSessionId)
                .catch(() => undefined);
            }
          })();
        };

        onEvent = session.on("Fetch.requestPaused", handler);
        // The request is opened by the document, not by `Page.navigate`: the
        // capture target never shows a PDF viewer, so there is no "load" to
        // await and no viewer document to mistake for the payload.
        void session
          .send(
            "Runtime.evaluate",
            {
              expression: `fetch(${JSON.stringify(url)}, { credentials: "include" }).catch(() => {})`,
              awaitPromise: false,
            },
            captureSessionId,
          )
          .catch((error: unknown) => {
            finish(() => reject(error));
          });

        options.signal?.addEventListener("abort", onAbort, { once: true });
      }),
      timeoutMs,
      url,
    );

    return outcome;
  } catch (error) {
    if (isWebSearchError(error)) throw error;
    throw fail("E_CDP_DISCONNECTED", "read", {
      message: `the browser could not fetch the response body: ${error instanceof Error ? error.message : String(error)}`,
      hint: "retry; if it repeats, run /web-doctor and check that the owned tab was not closed",
    });
  } finally {
    if (sessionId !== undefined) {
      await session.send("Fetch.disable", {}, sessionId).catch(() => undefined);
    }
    if (targetId !== undefined) {
      await session.closeTarget(targetId).catch(() => undefined);
    }
  }
}
