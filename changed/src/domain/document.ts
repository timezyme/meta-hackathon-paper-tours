import { Schema } from "effect"
import { ReadingGuide } from "./guide.ts"
import { ArtifactHash, BlockId, Count, DocumentId, FigureId, ImageArtifact, NonBlank, NonNegative, OutputScope, PageId, Positive, PositiveInt, ProviderAttemptId, RelativePath, SchemaVersion, SourceHash, SourceScope, Timestamp, UserId } from "./identity.ts"

export const DocumentLifecycle = Schema.TaggedUnion({ active: {}, expired: { at: Timestamp }, deleted: { at: Timestamp } })
export const Document = Schema.Struct({
  schemaVersion: SchemaVersion,
  id: DocumentId,
  ownerId: UserId,
  originalFilename: NonBlank.check(
    Schema.isPattern(/^[^/\\]+$/),
    Schema.makeFilter((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) || "Filename contains control characters"),
  ),
  mediaType: Schema.Literal("application/pdf"),
  byteCount: PositiveInt,
  sourceHash: SourceHash,
  pageCount: PositiveInt,
  sourceArtifact: Schema.Literal("source.pdf"),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lifecycle: DocumentLifecycle,
})
export type Document = typeof Document.Type

export const PixelBox = Schema.Struct({
  coordinateSystem: Schema.Literal("rendered-page-top-left-pixels"),
  x: NonNegative,
  y: NonNegative,
  width: Positive,
  height: Positive,
})
export type PixelBox = typeof PixelBox.Type
export const SourceLocation = Schema.TaggedUnion({
  page: { pageId: PageId, pageNumber: PositiveInt },
  box: { pageId: PageId, pageNumber: PositiveInt, box: PixelBox },
})
export type SourceLocation = typeof SourceLocation.Type

export const Page = Schema.Struct({
  id: PageId,
  pageNumber: PositiveInt,
  width: PositiveInt,
  height: PositiveInt,
  dpi: Positive,
  sourceWidth: Positive,
  sourceHeight: Positive,
  sourceUnit: Schema.Literals(["pdf-points", "pixels", "fraction", "thousandths"]),
  sourceOrigin: Schema.Literals(["top-left", "bottom-left"]),
  clockwiseRotation: Schema.Literals([0, 90, 180, 270]),
  sourceToRendered: Schema.Struct({ a: Schema.Finite, b: Schema.Finite, c: Schema.Finite, d: Schema.Finite, e: Schema.Finite, f: Schema.Finite }),
  image: Schema.Struct({ path: RelativePath, mediaType: Schema.Literal("image/png"), byteCount: PositiveInt, hash: ArtifactHash }),
})
export type Page = typeof Page.Type

export const BlockKind = Schema.Literals(["heading", "paragraph", "list", "equation", "table", "caption", "reference", "note", "code", "figure", "unclassified"])
export const ContentFormat = Schema.Literals(["text", "markdown", "latex", "html"])
export const SourceBlock = Schema.Struct({
  id: BlockId,
  kind: BlockKind,
  readingOrder: Count,
  content: Schema.String,
  format: ContentFormat,
  locations: Schema.NonEmptyArray(SourceLocation),
})
export type SourceBlock = typeof SourceBlock.Type
export const PageFurniture = Schema.Struct({ blockId: BlockId, role: Schema.Literals(["header", "footer", "page_number"]) })
export const Block = Schema.Struct({
  ...SourceBlock.fields,
  sourceBlockIds: Schema.NonEmptyArray(BlockId),
  headingLevel: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
})
export type Block = typeof Block.Type
export const HeadingDecision = Schema.Struct({ blockId: BlockId, level: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))) })

export const FigureDescription = Schema.TaggedUnion({
  pending: {},
  generated: { text: NonBlank, providerAttemptId: ProviderAttemptId, label: Schema.Literal("AI-written") },
  unavailable: { reason: NonBlank },
})
export const RenderedRegionProvenance = Schema.TaggedStruct("rendered-page-region", {
  recipe: Schema.Literal("page-png-integer-crop-1"),
  sourceHash: SourceHash,
  pageId: PageId,
  pageNumber: PositiveInt,
  pageImageHash: ArtifactHash,
  pageWidth: PositiveInt,
  pageHeight: PositiveInt,
  box: PixelBox,
  width: PositiveInt,
  height: PositiveInt,
})
export const FigureAsset = Schema.TaggedUnion({ available: { artifact: ImageArtifact, provenance: Schema.optionalKey(RenderedRegionProvenance) }, unavailable: { reason: NonBlank } })
export const Figure = Schema.Struct({
  id: FigureId,
  sourceBlockIds: Schema.NonEmptyArray(BlockId),
  locations: Schema.NonEmptyArray(SourceLocation),
  captionBlockIds: Schema.Array(BlockId),
  originalCaption: Schema.String,
  asset: FigureAsset,
  description: FigureDescription,
})
export type Figure = typeof Figure.Type

export const Extraction = Schema.Struct({
  schemaVersion: SchemaVersion,
  scope: SourceScope,
  pages: Schema.NonEmptyArray(Page),
  sourceBlocks: Schema.Array(SourceBlock),
  pageFurniture: Schema.optionalKey(Schema.Array(PageFurniture)),
  figures: Schema.Array(Figure),
})
export type Extraction = typeof Extraction.Type
export const CanonicalDocument = Schema.Struct({
  schemaVersion: SchemaVersion,
  scope: OutputScope,
  sourceHash: SourceHash,
  pages: Schema.NonEmptyArray(Page),
  sourceBlocks: Schema.Array(SourceBlock),
  pageFurniture: Schema.optionalKey(Schema.Array(PageFurniture)),
  blocks: Schema.Array(Block),
  headingDecisions: Schema.Array(HeadingDecision),
  figures: Schema.Array(Figure),
  guide: Schema.optionalKey(ReadingGuide),
})
export type CanonicalDocument = typeof CanonicalDocument.Type
