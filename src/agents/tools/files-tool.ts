import { Type } from "@sinclair/typebox";

import { addRoot, indexStatus, removeRoot, searchFiles, syncIndex } from "../files/index.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ACTIONS = ["search", "folders", "add_folder", "remove_folder", "reindex"] as const;

const FilesSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "search = find passages in Sir's indexed files; folders = which folders are indexed and how many files; " +
      "add_folder / remove_folder = change the indexed folders (only when Sir asks); reindex = refresh now",
  }),
  query: Type.Optional(
    Type.String({ description: "search: keywords (names, terms, phrases from the document)" }),
  ),
  folder: Type.Optional(
    Type.String({
      description: "search: limit to this folder; add_folder/remove_folder: the folder",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "search: max results (default 8)" })),
});

export function createFilesTool(): AnyAgentTool {
  return {
    label: "Files",
    name: "files",
    description:
      "Search Sir's own files (notes, PDFs, Word/PowerPoint, code and docs in the folders he chose) on this computer. " +
      "Use it before answering questions about his notes, coursework, projects or documents, and name the file " +
      "(and page) you used. Search with distinctive keywords; try synonyms if the first search finds nothing. " +
      "Open a result with the read tool for more context.",
    parameters: FilesSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      switch (action) {
        case "search": {
          const query = readStringParam(params, "query", { required: true });
          const status = indexStatus();
          if (!status.folders.length)
            return jsonResult({
              results: [],
              note: "No folders are indexed yet. Ask Sir which folders to add.",
            });
          // Keep the index fresh without making him wait for it.
          void syncIndex().catch(() => {});
          const results = searchFiles(query, {
            folder: readStringParam(params, "folder"),
            limit: readNumberParam(params, "limit"),
          });
          return jsonResult({
            results,
            ...(status.syncing || !status.lastSync
              ? { note: "Indexing is still running; results may be incomplete." }
              : {}),
          });
        }
        case "folders":
          return jsonResult(indexStatus());
        case "add_folder": {
          const roots = addRoot(readStringParam(params, "folder", { required: true }));
          void syncIndex().catch(() => {});
          return jsonResult({
            folders: roots.map((r) => r.path),
            note: "Indexing in the background.",
          });
        }
        case "remove_folder":
          return jsonResult({
            folders: removeRoot(readStringParam(params, "folder", { required: true })).map(
              (r) => r.path,
            ),
          });
        case "reindex":
          return jsonResult(await syncIndex());
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
