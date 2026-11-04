import { Schema } from "effect"
import { ArtifactHash, BlockId, Count, Document, Extraction, ImageArtifact, Issue, NonBlank, Page, Positive, PositiveInt, RelativePath, RunId } from "../../../domain/index.ts"

export const MINERU_VERSION = "4.0.12"
export const MineruLimits = { maxCompressedBytes: 50 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024, maxEntries: 1000, maxDepth: 32, maxNodes: 100_000 } as const

export const RenderedPage = Schema.Struct({
  pageNumber: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
  dpi: Positive,
  widthPoints: Positive,
  heightPoints: Positive,
  rotation: Schema.Literals([0, 90, 180, 270]),
  image: Page.fields.image,
})
export type RenderedPage = typeof RenderedPage.Type

export const MineruArchiveEntry = Schema.Union([
  Schema.TaggedStruct("file", { path: RelativePath, byteCount: Count, hash: ArtifactHash }),
  Schema.TaggedStruct("directory", { path: RelativePath, byteCount: Schema.Literal(0) }),
])
export type MineruArchiveEntry = typeof MineruArchiveEntry.Type

export const MineruArchiveManifest = Schema.Struct({
  compressedByteCount: PositiveInt,
  middlePath: RelativePath,
  entries: Schema.NonEmptyArray(MineruArchiveEntry),
  nativeAssets: Schema.Array(Schema.Struct({ archivePath: RelativePath, artifact: ImageArtifact })),
})
export type MineruArchiveManifest = typeof MineruArchiveManifest.Type

export const MineruConversionInput = Schema.Struct({
  document: Document,
  runId: RunId,
  middle: Schema.Unknown,
  renderedPages: Schema.NonEmptyArray(RenderedPage),
  archive: MineruArchiveManifest,
})
export type MineruConversionInput = typeof MineruConversionInput.Type

export const SourceAccounting = Schema.Struct({
  sourcePath: NonBlank,
  sourceType: NonBlank,
  pageNumber: PositiveInt,
  sourceBlockIds: Schema.NonEmptyArray(BlockId),
})
export type SourceAccounting = typeof SourceAccounting.Type

export const MineruConversion = Schema.Struct({
  extraction: Extraction,
  accounting: Schema.Array(SourceAccounting),
  issues: Schema.Array(Issue),
})
export type MineruConversion = typeof MineruConversion.Type

export class MineruConversionError extends Schema.TaggedError<MineruConversionError>()("MineruConversionError", {
  code: Schema.Literals(["invalid-response", "unsupported-version", "page-coverage", "coordinates", "archive-manifest", "limit-exceeded", "content"]),
  path: NonBlank,
  message: NonBlank,
}) {}

const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const MineruBox = Schema.Tuple([Fraction, Fraction, Fraction, Fraction]).check(Schema.makeFilter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0 || "Box must have positive width and height"))
export type MineruBox = typeof MineruBox.Type

export interface MineruNode {
  readonly type: string
  readonly index?: number
  readonly bbox?: MineruBox
  readonly content: string | ReadonlyArray<MineruNode>
  readonly image_path?: string
  readonly url?: string
  readonly styles?: ReadonlyArray<string>
  readonly level?: number
  readonly sub_type?: string
  readonly guess_lang?: string
  readonly [key: string]: unknown
}

export const MineruNode: Schema.Codec<MineruNode> = Schema.suspend(() => Schema.StructWithRest(Schema.Struct({
  type: NonBlank,
  index: Schema.optionalKey(Count),
  bbox: Schema.optionalKey(MineruBox),
  content: Schema.Union([Schema.String, Schema.Array(MineruNode)]),
  image_path: Schema.optionalKey(RelativePath),
  url: Schema.optionalKey(NonBlank.check(Schema.makeFilter((value) => URL.canParse(value) || "Hyperlink URL must be valid"))),
  styles: Schema.optionalKey(Schema.Array(Schema.Literals(["bold", "italic", "underline", "emphasis", "strikethrough", "superscript", "subscript"]))),
  level: Schema.optionalKey(PositiveInt),
  sub_type: Schema.optionalKey(NonBlank),
  guess_lang: Schema.optionalKey(NonBlank),
}), [Schema.Record(Schema.String, Schema.Unknown)]))

export const MineruMiddle = Schema.Struct({
  schema: Schema.Literal("docvortex.middle"),
  schema_version: Schema.Literal("2.0"),
  metadata: Schema.Struct({
    file_suffix: Schema.Literal("pdf"),
    producer: Schema.Struct({ name: Schema.Literal("mineru"), version: Schema.Literal(MINERU_VERSION) }),
    document: Schema.Struct({ page_count: PositiveInt, page_count_kind: Schema.Literal("physical") }),
  }),
  extensions: Schema.Struct({ docvortex_layout: Schema.Struct({ version: Schema.Literal(1), pages: Schema.NonEmptyArray(Schema.Struct({ page_idx: Count, width_pt: Positive, height_pt: Positive })) }) }),
  pages: Schema.NonEmptyArray(Schema.Struct({ page_idx: Count, blocks: Schema.Array(MineruNode) })),
  is_full_document: Schema.Literal(true),
})
export type MineruMiddle = typeof MineruMiddle.Type
