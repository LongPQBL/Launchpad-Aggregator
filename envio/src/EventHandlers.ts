import { registerEventHandlers } from "./EventHandlersCore";

registerEventHandlers(process.env.ENVIO_POOL_SEED_MODE === "seeded" ? "window" : "normal");
