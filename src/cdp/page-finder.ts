interface CDPPage {
  type?: string;
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function listPages(port: number): Promise<CDPPage[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP port must be an integer from 1 to 65535.");
  }
  const url = `http://127.0.0.1:${port}/json`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(
      `Cannot connect to Screen Studio on port ${port}.\n` +
        `Run: screenstudio launch`,
    );
  }

  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
  const pages: CDPPage[] = await response.json();
  if (!Array.isArray(pages)) throw new Error("CDP endpoint did not return a target list.");
  return pages.filter(p => p && (!p.type || p.type === "page") &&
    typeof p.url === "string" && typeof p.webSocketDebuggerUrl === "string");
}

// Screen Studio 4 loads index.html twice: in the main window and in a hidden render
// worker. Only the main window registers the open projects.
const MAIN_WINDOW_CHECK = "typeof electronEnv !== 'undefined' && !electronEnv.IS_RENDER_WORKER && !!window.$projects";

async function isMainWindow(wsUrl: string, timeoutMs = 3000): Promise<boolean> {
  const ws = new WebSocket(wsUrl);
  try {
    return await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      const done = (value: boolean) => { clearTimeout(timeout); resolve(value); };
      ws.addEventListener("error", () => done(false));
      ws.addEventListener("close", () => done(false));
      ws.addEventListener("open", () => ws.send(JSON.stringify({
        id: 1, method: "Runtime.evaluate", params: { expression: MAIN_WINDOW_CHECK, returnByValue: true },
      })));
      ws.addEventListener("message", event => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id === 1) done(msg.result?.result?.value === true);
        } catch { /* Ignore unrelated protocol events. */ }
      });
    });
  } finally {
    ws.close();
  }
}

export async function findRendererPage(port: number): Promise<string> {
  const candidates = (await listPages(port)).filter(p => p.url.includes("app.asar/dist/index.html"));
  if (!candidates.length) {
    throw new Error("Screen Studio is running but the main window was not found.");
  }
  for (const page of candidates) {
    if (await isMainWindow(page.webSocketDebuggerUrl)) return page.webSocketDebuggerUrl;
  }
  throw new Error("Screen Studio is running but its main window is not ready yet.");
}
