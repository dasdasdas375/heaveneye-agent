const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5173"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    NODE_ENV: "development",
  },
});

let electron;

const waitForDevServer = async () => {
  const url = "http://127.0.0.1:5173";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Vite dev server did not start in time.");
};

const launchElectron = async () => {
  await waitForDevServer();
  electron = spawn("npx", ["electron", "."], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  });

  electron.on("exit", () => {
    vite.kill();
  });
};

launchElectron().catch((error) => {
  console.error(error);
  vite.kill();
  process.exit(1);
});

process.on("SIGINT", () => {
  electron?.kill();
  vite.kill();
  process.exit(0);
});
