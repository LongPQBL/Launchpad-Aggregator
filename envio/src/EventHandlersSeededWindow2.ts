import { registerEventHandlers } from "./EventHandlersCore";
import { seedPoolsThrough } from "./seeded-cloud-pools.generated";

registerEventHandlers("cloud", 18600612n, seedPoolsThrough(28600611));
