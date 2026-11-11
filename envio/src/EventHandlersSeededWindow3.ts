import { registerEventHandlers } from "./EventHandlersCore";
import { seedPoolsThrough } from "./seeded-cloud-pools.generated";

registerEventHandlers("cloud", 28600612n, seedPoolsThrough(38600611));
