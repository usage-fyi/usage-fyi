export async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const proc = Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    // ignore browser open failures silently
  }
}
