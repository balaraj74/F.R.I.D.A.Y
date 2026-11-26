import { listJobs } from "../../agents/jobs/store.js";
import type { GatewayRequestHandlers } from "./types.js";

export const jobsHandlers: GatewayRequestHandlers = {
  // Recent background jobs with their steps, for the HUD's job cards.
  "jobs.list": async ({ respond }) => {
    respond(true, { jobs: listJobs().slice(0, 10) }, undefined);
  },
};
