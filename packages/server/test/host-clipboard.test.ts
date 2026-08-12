import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  createHostClipboardWriter,
  hostClipboardCommands,
  HostClipboardError,
  HOST_CLIPBOARD_MAX_BYTES,
  macosGuiSessionAvailable,
  runHostClipboardCommand,
} from "../src/host-clipboard.js";

describe("host clipboard", () => {
  test("uses the native macOS clipboard without placing selected text in argv", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const writer = createHostClipboardWriter({
      platform: "darwin",
      env: {},
      run,
      uid: 501,
      macosGuiAvailable: () => true,
    });

    await writer.writeText("private terminal selection");

    expect(run).toHaveBeenCalledWith(
      { command: "/usr/bin/pbcopy", args: [] },
      "private terminal selection",
      expect.objectContaining({ LC_CTYPE: expect.stringContaining("UTF-8") }),
      3_000,
    );
    expect(run.mock.calls[0]![0].args).not.toContain("private terminal selection");
  });

  test("does not claim a macOS host copy when no GUI pasteboard exists", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const macosGuiAvailable = vi.fn().mockReturnValue(false);
    const writer = createHostClipboardWriter({ platform: "darwin", env: {}, run, uid: 501, macosGuiAvailable });

    await expect(writer.writeText("browser selection still copies locally")).rejects.toEqual(
      new HostClipboardError("UNAVAILABLE"),
    );

    expect(macosGuiAvailable).toHaveBeenCalledWith(501);
    expect(run).not.toHaveBeenCalled();
  });

  test("probes the macOS GUI launchd domain without exposing clipboard contents", () => {
    const run = vi.fn().mockReturnValue({ status: 0 });
    expect(macosGuiSessionAvailable(501, run)).toBe(true);
    expect(run).toHaveBeenCalledWith("/bin/launchctl", ["print", "gui/501"]);
    expect(macosGuiSessionAvailable(-1, run)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  test("prefers the active Linux display system and falls back across native helpers", async () => {
    expect(
      hostClipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }).map((x) => x.command),
    ).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(hostClipboardCommands("linux", { DISPLAY: ":0" }).map((x) => x.command)).toEqual([
      "xclip",
      "xsel",
      "wl-copy",
    ]);

    const run = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce(undefined);
    const writer = createHostClipboardWriter({ platform: "linux", env: { DISPLAY: ":0" }, run });
    await writer.writeText("fallback text");
    expect(run.mock.calls.map((call) => call[0].command)).toEqual(["xclip", "xsel"]);
  });

  test("pipes text through stdin and accepts only a successful native helper exit", async () => {
    const text = "multiline clipboard\nwith unicode: ğüş";
    const expectedHash = createHash("sha256").update(text).digest("hex");
    const script =
      'const c=require("node:crypto");let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.exit(c.createHash("sha256").update(s).digest("hex")===process.env.RC_CLIPBOARD_TEST_HASH?0:9));';
    await expect(
      runHostClipboardCommand(
        { command: process.execPath, args: ["-e", script] },
        text,
        { ...process.env, RC_CLIPBOARD_TEST_HASH: expectedHash },
        2_000,
      ),
    ).resolves.toBeUndefined();
    await expect(
      runHostClipboardCommand(
        {
          command: process.execPath,
          args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))"],
        },
        text,
        process.env,
        2_000,
      ),
    ).rejects.toThrow("status 7");
  });

  test("rejects empty, oversized, and unsupported clipboard writes", async () => {
    const writer = createHostClipboardWriter({ platform: "aix", env: {}, run: vi.fn() });
    await expect(writer.writeText("")).rejects.toMatchObject({ code: "EMPTY" });
    await expect(writer.writeText("x".repeat(HOST_CLIPBOARD_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    await expect(writer.writeText("text")).rejects.toEqual(new HostClipboardError("UNAVAILABLE"));
  });
});
