import { spawn } from "node:child_process";

export async function openBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const proc = spawn(cmd, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    proc.unref();
  } catch {
    // ignore browser open failures silently
  }
}
