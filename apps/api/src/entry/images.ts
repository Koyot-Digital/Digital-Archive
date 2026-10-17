import { buildImagesApp } from "../app/images.js";
import { serve } from "./bootstrap.js";
import { config } from "../config.js";

const app = await buildImagesApp();
await serve(app, { port: config.IMAGES_PORT, name: "api-images" });
