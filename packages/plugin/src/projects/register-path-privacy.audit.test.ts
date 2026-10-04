import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Audit (04-08 truth 3, D-43, PROJ-14): the picked or typed path travels only
// in the register POST body. No module on the register path may reach plugin
// persistence (saveData/loadData, settings) or the vault.

const FILES = [
  "./folder-picker.ts",
  "./projects-actions.ts",
  "../view/register-flow.tsx",
  "../view/projects-view.tsx",
  "../view/project-card.tsx",
  "../view/project-manage-toolbar.tsx",
];

const PERSISTENCE =
  /\b(saveData|loadData|saveSettings|settings\.|localStorage|sessionStorage|vault)\b/;

describe("audit: the register path never persists the folder path", () => {
  for (const file of FILES) {
    it(`${file} references no plugin persistence or vault API`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      expect(code).not.toMatch(PERSISTENCE);
    });
  }
});
