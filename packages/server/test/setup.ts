// Never let a local test run discover, adopt, or stop sessions on the production tmux socket. This is
// installed before test modules import terminal-process.ts, and child processes inherit the same socket.
process.env.RC_TMUX_SOCKET ||= `roamcode-vitest-${process.pid}`;
