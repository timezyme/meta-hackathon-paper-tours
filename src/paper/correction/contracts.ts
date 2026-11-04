import { Schema } from "effect"
import { BlockId, CheckedPage, PageCheck, SourceBlock, SourceScope } from "../../domain/index.ts"

export const CorrectedText = Schema.Struct({
  scope: SourceScope,
  blocks: Schema.Array(SourceBlock),
  joins: PageCheck.fields.joins,
  changedBlockIds: Schema.Array(BlockId),
  checkedPages: Schema.Array(CheckedPage),
})
export type CorrectedText = typeof CorrectedText.Type
