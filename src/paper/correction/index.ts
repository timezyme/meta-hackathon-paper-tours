import { pageExtractionSpec } from "../extraction/page.ts"
import { figuresSpec } from "../figures/index.ts"
import { headingsSpec } from "../headings/index.ts"
import { guideSpec } from "../guide/index.ts"
import type { MetaStageSpecs } from "../providers/meta/contracts.ts"
import { pageCheckSpec } from "./page-check.ts"

export * from "./contracts.ts"
export * from "./format.ts"
export * from "./page-check.ts"
export * from "./requests.ts"
export const stageSpecs: MetaStageSpecs = { extraction: pageExtractionSpec, "page-check": pageCheckSpec, headings: headingsSpec, figures: figuresSpec, guide: guideSpec }
