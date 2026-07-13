// Service templates and persistence live in the server package because OTA migration must use the
// exact same implementation as `roamcode install`. Re-export them here for the CLI public/test seam.
export { buildServicePath, installService, renderLaunchdPlist, renderSystemdUnit } from "@roamcode.ai/server";

export type {
  InstallServiceContext as InstallContext,
  InstallServiceResult as InstallResult,
  RenderLaunchdOptions,
  RenderSystemdOptions,
} from "@roamcode.ai/server";
