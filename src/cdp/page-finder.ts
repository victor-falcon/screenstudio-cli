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

export async function findRendererPage(port: number): Promise<string> {
  const pages = await listPages(port);
  const renderer = pages.find(
    p => p.url.includes("app.asar/dist/index.html"),
  );

  if (!renderer) {
    throw new Error(
      "Screen Studio is running but the main window was not found.",
    );
  }

  return renderer.webSocketDebuggerUrl;
}

export async function findPreviewPage(port: number): Promise<string> {
  const pages = (await listPages(port)).filter(p =>
    !p.url.includes("index.html") && !p.url.startsWith("devtools:"));
  if (!pages.length) throw new Error("Could not find a preview window. Is a project open?");
  if (pages.length > 1) {
    throw new Error("Multiple auxiliary windows are open. Close other project and recording picker windows before capturing a preview.");
  }
  return pages[0].webSocketDebuggerUrl;
}
