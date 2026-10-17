import { buildTextApp } from "../app/text.js";
import { serve } from "./bootstrap.js";
import { config } from "../config.js";

const app = await buildTextApp();
// The text service owns the schema; the images service only reads it.
await serve(app, { port: config.TEXT_PORT, name: "api-text", runMigrations: true });
