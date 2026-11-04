import { Schema } from "effect"
import { DocumentId, RunId, RunState } from "../domain/index.ts"
import { PrivateArtifact } from "../storage/index.ts"

export const WorkInput = Schema.Struct({ documentId: DocumentId, runId: RunId })
export type WorkInput = typeof WorkInput.Type
export const Extracted = Schema.Struct({ ...WorkInput.fields, extraction: PrivateArtifact })
export const Corrected = Schema.Struct({ ...Extracted.fields, correction: PrivateArtifact })
export const Hierarchy = Schema.Struct({ ...Corrected.fields, hierarchy: PrivateArtifact })
export const Described = Schema.Struct({ ...Hierarchy.fields, descriptions: PrivateArtifact })
export const Assembled = Schema.Struct({ ...Described.fields, publication: PrivateArtifact })
export const Published = Schema.Struct({ ...WorkInput.fields, state: RunState })
export type Checkpoint = typeof WorkInput.Type | typeof Extracted.Type | typeof Corrected.Type | typeof Hierarchy.Type | typeof Described.Type | typeof Assembled.Type | typeof Published.Type
