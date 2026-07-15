import { spawnSync } from "node:child_process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const context = input ? JSON.parse(input) : {};
const title = String(context.title ?? "RoamCode needs you")
  .replace(/[\r\n]/g, " ")
  .slice(0, 80);
const body = String(context.body ?? `${context.eventType ?? "An agent event"} · ${context.resourceType ?? "resource"}`)
  .replace(/[\r\n]/g, " ")
  .slice(0, 180);

let delivery = "preview";
if (context.deliver === true && process.platform === "darwin") {
  const script = "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";
  const result = spawnSync("/usr/bin/osascript", ["-e", script, title, body], {
    encoding: "utf8",
    timeout: 2000,
  });
  delivery = result.status === 0 ? "delivered" : "unavailable";
} else if (context.deliver === true && process.platform === "linux") {
  const result = spawnSync("notify-send", ["--app-name=RoamCode", title, body], {
    encoding: "utf8",
    timeout: 2000,
  });
  delivery = result.status === 0 ? "delivered" : "unavailable";
}

process.stdout.write(JSON.stringify({ delivery, notification: { title, body } }));
