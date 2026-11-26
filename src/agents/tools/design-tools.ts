// "Show me looks first": when Sir asks FRIDAY to build anything with a UI, she makes 3 or 4
// reference images, he picks one (in chat or by clicking in the HUD), and only then she builds.
//   design_references  makes the pictures and shows them
//   design_choose      records his pick and writes DESIGN.md + tokens into the project
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FRIDAYConfig } from "../../config/config.js";
import { recordChoice } from "../../design/options/choose.js";
import { generateDesignOptions } from "../../design/options/generate.js";
import { createPlaywrightCapture } from "../../design/refs/pipeline-defaults.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import { createImageGenerateTool, resolveGeneratedDir } from "./image-generate-tool.js";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "project";

/** A bare name lives under ~/friday/projects; an absolute path is used as given. */
export function resolveProjectDir(project: string, home = os.homedir()): string {
  const p = project.trim().replace(/^~(?=$|\/)/, home);
  return path.isAbsolute(p) ? path.resolve(p) : path.join(home, "friday", "projects", slugify(p));
}

/** "2", "1,3", "option 2 and 4" -> [2] / [1, 3] / [2, 4]. */
export function parseChoice(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= 9);
}

const ReferencesSchema = Type.Object({
  brief: Type.String({
    description:
      "What Sir wants built, in his words plus what you know: product, audience, key screens. Used to draw each reference.",
  }),
  project: Type.Optional(
    Type.String({
      description:
        "Project name or absolute folder. A bare name becomes ~/friday/projects/<name>. Defaults to a name made from the brief.",
    }),
  ),
  count: Type.Optional(Type.Number({ description: "How many looks to offer: 3 or 4 (default 4)." })),
});

const ChooseSchema = Type.Object({
  project: Type.String({ description: "The same project name or folder given to design_references." }),
  choice: Type.String({
    description: "Option number(s) Sir picked, e.g. '2' or '1,3' if he wants to mix. The first is the main look.",
  }),
  note: Type.Optional(Type.String({ description: "Anything Sir said about changes to the chosen look." })),
});

export function createDesignReferencesTool(options: {
  config?: FRIDAYConfig;
  workspaceDir?: string;
  fetchImpl?: typeof fetch;
}): AnyAgentTool {
  return {
    label: "Design references",
    name: "design_references",
    description:
      "REQUIRED before building any web app, site, dashboard or other screen-based UI Sir asks for. Makes 3 or 4 " +
      "reference pictures of different looks. After it returns, show them (put each MEDIA: line on its own line, then " +
      "the DESIGN_CHOICE: line unchanged), ask Sir which one he wants, and STOP. Write no UI code until he answers; " +
      "then call design_choose. Takes a few minutes; tell Sir you are drawing options first.",
    parameters: ReferencesSchema,
    execute: async (_id, params) => {
      const brief = readStringParam(params, "brief", { required: true });
      const project = readStringParam(params, "project") ?? brief;
      const count = typeof params.count === "number" ? params.count : undefined;
      const projectDir = resolveProjectDir(project);
      const imageTool = createImageGenerateTool({
        config: options.config,
        workspaceDir: options.workspaceDir,
        fetchImpl: options.fetchImpl,
      });
      const capture = createPlaywrightCapture();
      try {
        const result = await generateDesignOptions(
          { brief, count, projectDir },
          {
            generateImage: async (prompt) => {
              const res = await imageTool.execute(`design-${Date.now()}`, { prompt } as never);
              const file = (res.details as { path?: string } | undefined)?.path;
              if (!file) throw new Error("image_generate returned no saved file path");
              return { path: file };
            },
            captureHtml: (req) =>
              capture.captureHtml({ ...req, screen: "home", direction: "instrument", index: 0 }),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            mediaDir: resolveGeneratedDir(options.workspaceDir),
          },
        );
        if (result.options.length === 0) {
          throw new Error(
            `Could not make any reference pictures: ${result.failed.map((f) => f.reason).join(" | ")}`,
          );
        }
        const lines = result.options.flatMap((o) => [
          `Option ${o.id} (${o.label})${o.source === "html_fallback" ? " [rough mockup, image quota was used up]" : ""}:`,
          `MEDIA:${o.mediaPath}`,
        ]);
        const choice = result.options.map((o) => `${o.id}=${o.label}`).join("; ");
        return {
          content: [
            {
              type: "text",
              text:
                `${lines.join("\n")}\n\nDESIGN_CHOICE: ${choice}\n\n` +
                `Project folder: ${projectDir}\n` +
                "Now show Sir every option (each MEDIA: line on its own line, then the DESIGN_CHOICE: line exactly as written), " +
                "describe each look in one short line, ask which he wants (he can reply with a number, say 'mix 1 and 3', " +
                "or click one in the HUD), and wait. Do not write any UI code yet.",
            },
          ],
          details: { projectDir, options: result.options, failed: result.failed },
        };
      } finally {
        await capture.close();
      }
    },
  };
}

export function createDesignChooseTool(): AnyAgentTool {
  return {
    label: "Design choice",
    name: "design_choose",
    description:
      "Record which reference Sir picked. Writes design/reference.*, design/tokens.json (+ generated tokens.css and " +
      "tailwind.tokens.js) and design/DESIGN.md in the project. Call this once he has chosen, then build the UI to match " +
      "the chosen picture, using only the token values.",
    parameters: ChooseSchema,
    execute: async (_id, params) => {
      const project = readStringParam(params, "project", { required: true });
      const choice = readStringParam(params, "choice", { required: true });
      const note = readStringParam(params, "note") ?? "";
      const ids = parseChoice(choice);
      const projectDir = resolveProjectDir(project);
      const result = await recordChoice({ projectDir, ids, note });
      return {
        content: [
          {
            type: "text",
            text:
              `Recorded: ${result.chosen.map((c) => `${c.id} (${c.label})`).join(" + ")}.\n` +
              `Reference: ${result.referencePath}\nDesign spec: ${result.designSpecPath}\nTokens: ${result.tokensPath}\n\n` +
              "Next: open the reference picture with the image tool and compare it with design/tokens.json. Adjust the token " +
              "values to match the picture (colours, fonts, radii), then rebuild with `friday design tokens build --dir <project>/design`. " +
              "Build the UI using token variables only: no hard-coded hex colours or arbitrary values. When done, screenshot " +
              "the result and compare it with the reference.",
          },
        ],
        details: result,
      };
    },
  };
}
