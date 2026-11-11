import { registerEventHandlers } from "./EventHandlersCore";
import { seedPoolsThrough } from "./seeded-cloud-pools.generated";

registerEventHandlers("cloud", 8600612n, seedPoolsThrough(18600611));
