const net = require("net");

// Check Redis connection as health indicator
const client = net.createConnection({ host: "redis", port: 6379 }, () => {
  client.end();
  process.exit(0);
});

client.on("error", () => {
  process.exit(1);
});

setTimeout(() => {
  process.exit(1);
}, 3000);
