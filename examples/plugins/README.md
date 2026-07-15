# Reference plugins

These packages exercise the public `roamcode-extension.json` contract without depending on a marketplace or a
RoamCode account. They are intentionally unsigned source examples: inspect their SRI first, then install with the
host recovery credential and an explicit unsigned-package approval.

- `notifications` formats attention events and can invoke the native macOS/Linux desktop notifier.
- `project-bootstrap` previews a guarded worktree command and only mutates git when `apply:true` is explicit.
- `ci-release-monitor` reports coarse repository and workflow/release posture without reading source contents.

Every action receives at most 16 KiB of JSON on stdin and emits bounded JSON on stdout. RoamCode strips provider and
API credentials from the environment, confines the action cwd to `FS_ROOT`, verifies package integrity before every
run, and records lifecycle metadata without command output.
