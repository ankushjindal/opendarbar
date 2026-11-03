// Git status widget — top-level status + submodule porcelain for a configured repo path.

import { shell } from "../lib/shell";

export function gitWidget(opts: { repoPath: string }) {
  return async function(): Promise<string> {
    const top = await shell(["git", "-C", opts.repoPath, "status", "--porcelain"]);
    const sub = await shell([
      "git", "-C", opts.repoPath, "submodule", "foreach", "--quiet",
      `if [ -n "$(git status --porcelain)" ]; then echo "MOD:$name"; git status --porcelain | head -5; echo "END"; fi`,
    ]);

    let html = "";

    if (top.stdout.trim()) {
      const files = top.stdout.trim().split("\n").slice(0, 5);
      html += `<div class="git-module"><span class="git-module-name">root</span>`;
      for (const f of files) html += `<div class="git-file">${f.trim()}</div>`;
      html += `</div>`;
    }

    if (sub.stdout.trim()) {
      const blocks = sub.stdout.split("END").filter((b) => b.includes("MOD:"));
      for (const block of blocks) {
        const lines = block.trim().split("\n");
        const modLine = lines.find((l) => l.startsWith("MOD:"));
        if (!modLine) continue;
        const name = modLine.replace("MOD:", "");
        const files = lines.filter((l) => !l.startsWith("MOD:")).slice(0, 3);
        html += `<div class="git-module"><span class="git-module-name">${name}</span>`;
        for (const f of files) html += `<div class="git-file">${f.trim()}</div>`;
        html += `</div>`;
      }
    }

    return html || `<p style="color:var(--green)">All clean</p>`;
  };
}
