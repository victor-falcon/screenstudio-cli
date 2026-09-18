import { findRendererPage } from "./page-finder.js";

interface CDPResult {
  result?: { type: string; value?: unknown; description?: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private messageId = 0;

  constructor(private port = 9222, private timeoutMs = 30_000) {}

  async connect(wsUrl?: string): Promise<void> {
    const ws = new WebSocket(wsUrl ?? await findRendererPage(this.port));
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener("open", opened);
        ws.removeEventListener("error", failed);
        ws.removeEventListener("close", failed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => {
        cleanup();
        reject(new Error("Failed to connect to Screen Studio via WebSocket."));
      };
      const timeout = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error("Screen Studio WebSocket connection timed out."));
      }, this.timeoutMs);
      ws.addEventListener("open", opened);
      ws.addEventListener("error", failed);
      ws.addEventListener("close", failed);
    });
  }

  async request<T = CDPResult>(method: string, params: object = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected. Call connect() first.");
    }
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeEventListener("message", message);
        ws.removeEventListener("close", disconnected);
        ws.removeEventListener("error", disconnected);
      };
      const disconnected = () => {
        cleanup();
        reject(new Error("Screen Studio disconnected before the command completed."));
      };
      const message = (event: MessageEvent) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg.id !== id) return;
        cleanup();
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`));
        } else if (msg.result?.exceptionDetails) {
          const details = msg.result.exceptionDetails;
          reject(new Error(`Screen Studio error: ${details.exception?.description || details.text}`));
        } else {
          resolve(msg.result || {});
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP command timed out after ${this.timeoutMs / 1000} seconds.`));
      }, this.timeoutMs);
      ws.addEventListener("message", message);
      ws.addEventListener("close", disconnected);
      ws.addEventListener("error", disconnected);
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { cleanup(); reject(err); }
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    // Await IPC promises before serializing: JSON.stringify(Promise) is just {}.
    const wrapped = `(async function() {
      try { return JSON.stringify(await (async function() { ${expression} })()); }
      catch (e) { return JSON.stringify({ __error: true, message: String(e?.message ?? e) }); }
    })()`;
    const result = await this.request("Runtime.evaluate", {
      expression: wrapped, returnByValue: true, awaitPromise: true,
    });
    const raw = result.result?.value;
    if (raw === undefined || raw === null) return undefined as T;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed?.__error) throw new Error(parsed.message);
    // Existing command expressions use this shape for validation failures.
    if (parsed && typeof parsed.error === "string" && Object.keys(parsed).length === 1) {
      throw new Error(parsed.error);
    }
    return parsed as T;
  }

  async evaluateRaw(expression: string): Promise<string> {
    const result = await this.request("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    const value = result.result?.value;
    return value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value);
  }

  async dispatchKeyEvent(key: string, code: string, modifiers: number): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await this.request("Input.dispatchKeyEvent", { type, key, code, modifiers });
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

export async function withClient<T>(
  port: number,
  fn: (client: CDPClient) => Promise<T>,
  wsUrl?: string,
): Promise<T> {
  const client = new CDPClient(port);
  try {
    await client.connect(wsUrl);
    return await fn(client);
  } finally {
    client.disconnect();
  }
}
