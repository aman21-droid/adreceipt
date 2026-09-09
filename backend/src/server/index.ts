import express from "express";
import { config, settlementDeployment } from "../config";
import { errorHandler } from "./errors";
import { routes } from "./routes";
import { mountV2 } from "../v2/mount";

export function createServer() {
  const app = express();

  app.use(express.json({ limit: "64kb" }));
  app.disable("x-powered-by");
  // Render terminates TLS one hop in front of this process. Trust exactly that
  // hop so domain-specific throttles see the client address rather than every
  // visitor sharing the proxy address.
  app.set("trust proxy", 1);

  // Receipt evidence is public and read-only. The sole write endpoint records
  // a positive domain proof after a one-time wallet authorization.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  app.use(routes);
  app.use("/v2", mountV2());
  app.use((_req, res) => res.status(404).json({ error: "not-found" }));
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const app = createServer();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        `AdReceipt backend listening on :${config.port}`,
        `  network    ${config.network} (${config.chainId})`,
        `  settlement ${settlementDeployment.address}`,
        `  mode       receipt reads and signed domain attestations`,
      ].join("\n"),
    );
  });
}
