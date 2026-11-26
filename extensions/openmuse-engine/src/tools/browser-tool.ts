import { Type } from "@sinclair/typebox";
import type { FRIDAYPluginApi } from "../../../../src/plugins/types.js";
import type { BrowserDaemon } from "../browser-worker/browser-daemon.js";

export function createBrowserTool(_api: FRIDAYPluginApi, daemon: BrowserDaemon) {
  return {
    name: "muse_browser",
    description:
      "OpenMuse persistent browser automation. Allows navigating pages, capturing screenshots, reading text, clicking, and filling form fields with persistent session cookies and profiles.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("navigate"),
        Type.Literal("snapshot"),
        Type.Literal("click"),
        Type.Literal("fill"),
        Type.Literal("screenshot"),
        Type.Literal("evaluate"),
        Type.Literal("close"),
      ], { description: "The browser action to perform." }),
      url: Type.Optional(Type.String({ description: "URL to navigate to (required for 'navigate')." })),
      selector: Type.Optional(Type.String({ description: "CSS/XPath selector for click/fill." })),
      text: Type.Optional(Type.String({ description: "Text to fill into selected element." })),
      script: Type.Optional(Type.String({ description: "JavaScript snippet to execute in the page context." })),
      profileId: Type.Optional(Type.String({ description: "Profile identifier (default: 'default')." })),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = String(params.action || "");
      const profileId = (params.profileId as string) || "default";

      switch (action) {
        case "navigate": {
          const url = params.url as string;
          if (!url) throw new Error("URL is required for 'navigate' action");
          const res = await daemon.navigate(url, profileId);
          return {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            details: res,
          };
        }
        case "snapshot": {
          const res = await daemon.snapshot(profileId);
          return {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            details: res,
          };
        }
        case "click": {
          const selector = params.selector as string;
          if (!selector) throw new Error("selector is required for 'click' action");
          const res = await daemon.click(selector, profileId);
          return {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            details: res,
          };
        }
        case "fill": {
          const selector = params.selector as string;
          const text = (params.text as string) || "";
          if (!selector) throw new Error("selector is required for 'fill' action");
          const res = await daemon.fill(selector, text, profileId);
          return {
            content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            details: res,
          };
        }
        case "screenshot": {
          const res = await daemon.screenshot(profileId);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ savedPath: res.path, profileId }, null, 2),
              },
            ],
            details: { savedPath: res.path },
          };
        }
        case "evaluate": {
          const script = params.script as string;
          if (!script) throw new Error("script is required for 'evaluate' action");
          const result = await daemon.evaluate(script, profileId);
          return {
            content: [{ type: "text", text: JSON.stringify({ result }, null, 2) }],
            details: { result },
          };
        }
        case "close": {
          await daemon.closeProfile(profileId);
          return {
            content: [{ type: "text", text: JSON.stringify({ closed: true, profileId }, null, 2) }],
            details: { closed: true },
          };
        }
        default:
          throw new Error(`Unknown browser action: ${action}`);
      }
    },
  };
}
