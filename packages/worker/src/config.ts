/**
 * Typed accessor for the embedded config.
 *
 * `config.generated.ts` exports `CONFIG` as a deeply-`readonly` literal
 * (`as const`), which is great for byte-fidelity but too narrow to iterate as
 * `ResolvedSite[]` (e.g. `site.type` narrows to the literal `"http"`). We widen
 * it back to the `ResolvedConfig` contract here, once, for the runtime to use.
 */

import { CONFIG as GENERATED } from "./config.generated.js";
import type { ResolvedConfig } from "./config-types.js";

export const CONFIG: ResolvedConfig = GENERATED as unknown as ResolvedConfig;
