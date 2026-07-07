import express from "express";
import { requireAuth } from "./auth.js";
import { authRouter } from "./routes/auth.js";
import { dataRouter } from "./routes/data.js";

const app = express();

// Sessions with cookies can be sizeable — allow a generous JSON body.
app.use(express.json({ limit: "1mb" }));

// Every route (including /health) requires the shared bearer secret.
app.use(requireAuth);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/garmin", authRouter);
app.use("/garmin", dataRouter);

// Cloud Run injects PORT (defaults to 8080); the container must listen on it.
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`garmin-sidecar listening on :${port}`);
});
