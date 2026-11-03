// Quick actions widget + action handler. Mac-only: taildrop + custom script.

import { resolve } from "path";
import { shell } from "../lib/shell";

export interface ActionConfig {
  /** $HOME so we can resolve ~ and check containment. */
  home: string;
  /** Full path to `tailscale` binary. */
  tailscaleBin: string;
  /** Optional custom script absolute path. If unset, the button is hidden. */
  customScript?: string;
  /**
   * Map of taildrop target labels to tailscale device names.
   * UI shows a button per entry; action body must include `target` matching one of these keys.
   * Example: { iphone: 'phone', daylight: 'tablet' }
   */
  taildropTargets: Record<string, string>;
}

export function actionsWidget(opts: ActionConfig): string {
  const taildropButtons = Object.entries(opts.taildropTargets)
    .map(([key, name]) => {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      return `<button class="action-btn" onclick="doAction('taildrop', { path: prompt('File path to send to ${name}:'), target: '${key}' })">📤 Taildrop → ${label}</button>`;
    })
    .join("\n    ");
  const cookBtn = opts.customScript
    ? `<button class="action-btn" onclick="doAction('custom')">▶ Run custom action</button>`
    : "";

  return `
    ${cookBtn}
    ${taildropButtons}
    <div id="action-result" style="margin-top:8px;font-size:12px;color:var(--text3)"></div>
  `;
}

export function makeActionHandler(opts: ActionConfig) {
  return async function(name: string, body: any): Promise<{ success: boolean; message: string } | null> {
    if (name === "custom") {
      if (!opts.customScript) return { success: false, message: "custom action not configured" };
      const { exitCode, stderr } = await shell(
        ["bash", opts.customScript, "cook"],
        120_000
      );
      return exitCode === 0
        ? { success: true, message: "Cook message sent" }
        : { success: false, message: stderr || "Failed" };
    }

    if (name === "taildrop") {
      const filePath = body?.path;
      const targetKey = body?.target;
      if (!filePath) return { success: false, message: "No file path" };
      if (!targetKey || !opts.taildropTargets[targetKey]) {
        return { success: false, message: `Unknown taildrop target: ${targetKey}` };
      }
      const abs = resolve(filePath.startsWith("~") ? filePath.replace("~", opts.home) : filePath);
      if (!abs.startsWith(opts.home)) return { success: false, message: "Path outside home" };
      const target = `${opts.taildropTargets[targetKey]}:`;
      const { exitCode, stderr } = await shell([opts.tailscaleBin, "file", "cp", abs, target], 30_000);
      return exitCode === 0
        ? { success: true, message: `Sent to ${target}` }
        : { success: false, message: stderr || "Failed" };
    }

    return null; // unknown action — let bootstrap fall through
  };
}
