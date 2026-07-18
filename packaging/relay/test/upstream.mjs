import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "", 10);
const service = process.env.SERVICE ?? "unknown";
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

const server = createServer((request, response) => {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(
    JSON.stringify({
      service,
      method: request.method,
      url: request.url,
      headers: request.headers,
    }),
  );
});

server.on("upgrade", (request, socket) => {
  socket.end(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      `X-RoamCode-Test-Upstream: ${service}\r\n` +
      "\r\n",
  );
});

server.listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
