import { extractionSpec } from "../extraction/index.ts"
import { figuresSpec } from "../figures/index.ts"
import { headingsSpec } from "../headings/index.ts"
import type { MetaStageSpecs } from "../providers/meta/contracts.ts"
import { pageCheckSpec } from "./page-check.ts"

export * from "./contracts.ts"
export * from "./format.ts"
export * from "./page-check.ts"
export * from "./requests.ts"
export const stageSpecs: MetaStageSpecs = { extraction: extractionSpec, "page-check": pageCheckSpec, headings: headingsSpec, figures: figuresSpec }
