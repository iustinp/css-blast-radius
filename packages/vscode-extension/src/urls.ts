/** The editor connects to the same origin as the setup and diff pages. */
export function serverOrigin(setting: string): URL {
  const url = new URL(setting);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The server address must be an http:// host and port, without a path.");
  }
  return url;
}

export function isLocalServer(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

export function diffUrl(serverUrl: string, sessionId: string, pagePath: string, embed = false): string {
  const origin = serverOrigin(serverUrl).origin;
  return `${origin}/diff?s=${encodeURIComponent(sessionId)}&url=${encodeURIComponent(pagePath)}${embed ? "&embed=1" : ""}`;
}
